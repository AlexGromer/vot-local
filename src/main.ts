import { rmSync } from "node:fs";
import { copyFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import VOTClient, { VOTTypes } from "@vot.js/node";
import pkg from "../package.json";
import { cleanupOnSignals, errorMessage, onCleanup } from "./cleanup";
import { HELP, parseCommand, shouldPause, type TranslateOptions } from "./cli";
import { useUtf8Console } from "./console";
import { extractAudioArgs, probe } from "./media";
import { firstAttempt, muxArgs, outputPath, retryAttempt } from "./mux";
import { findTool, ProcessError, run } from "./process";
import {
  encodeRegFile,
  findPotPlayer,
  installRegFile,
  uninstallRegFile,
} from "./registry";
import { serveFile } from "./server";
import { type TranslateFn, waitForTranslation } from "./translate";
import { openTunnel, waitReachable } from "./tunnel";

const NO_ARGS_HINT = `VOT-local переводит видео с компьютера.
Чтобы добавить подменю «VOT: закадровый перевод» в меню видеофайлов, запустите install.cmd.
Потом нажмите правой кнопкой на видео и выберите нужный пункт.`;

function say(message: string) {
  console.log(message);
}

function friendlyError(err: unknown): string {
  const message = errorMessage(err);
  if (err instanceof Error && err.name === "VOTJSError") {
    return /auth required/i.test(message)
      ? "Для живых голосов нужен вход в аккаунт Яндекса (токен)"
      : `Сервис перевода не смог перевести этот файл (${message})`;
  }
  return message;
}

function makeTranslate(options: TranslateOptions): TranslateFn {
  const client = new VOTClient({ apiToken: options.apiToken });
  return (req) =>
    client.translateVideo({
      videoData: {
        url: req.url,
        duration: req.duration,
        host: VOTTypes.ServiceType.VideoService.custom,
        videoId: req.url,
      },
      requestLang: req.requestLang,
      responseLang: req.responseLang,
      extraOpts: { useLivelyVoice: req.livelyVoice },
    });
}

async function download(url: string, target: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      await Bun.write(target, res);
      return;
    } catch (err) {
      if (attempt >= 3) {
        throw new Error(`Не удалось скачать перевод: ${errorMessage(err)}`);
      }
      await Bun.sleep(5_000 * attempt);
    }
  }
}

type MuxBase = Omit<
  Parameters<typeof muxArgs>[0],
  "withSubtitles" | "reencodeVideo"
>;

async function mux(base: MuxBase, mp4SafeVideo: boolean) {
  let attempt = firstAttempt(base.format, mp4SafeVideo);
  for (;;) {
    try {
      await run(muxArgs({ ...base, ...attempt }));
      return;
    } catch (err) {
      const next =
        err instanceof ProcessError
          ? retryAttempt(base.format, attempt, err.stderr)
          : null;
      if (!next) {
        throw err;
      }
      attempt = next;
    }
  }
}

function openResult(file: string, openWith: string | undefined): boolean {
  const cmd = openWith
    ? [openWith, file]
    : process.platform === "win32"
      ? ["explorer.exe", file]
      : ["xdg-open", file];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).unref();
    return true;
  } catch (err) {
    say(`Не удалось открыть результат: ${errorMessage(err)}`);
    return false;
  }
}

async function translateFile(file: string, options: TranslateOptions) {
  const ffmpeg = findTool("ffmpeg");
  const ffprobe = findTool("ffprobe");
  const cloudflared = findTool("cloudflared");

  say(`Файл: ${basename(file)}`);
  const info = await probe(ffprobe, file);
  if (!info.audioStreams) {
    throw new Error("В файле нет звуковой дорожки, переводить нечего");
  }

  const output = outputPath(file, options.responseLang, options.format);
  const part = `${output}.part`;
  try {
    await writeFile(part, "");
  } catch {
    throw new Error(
      "Нет прав на запись в папку с видео: скопируйте видео в другую папку",
    );
  }
  const forgetPart = onCleanup(() => rmSync(part, { force: true }));

  const tmp = await mkdtemp(join(tmpdir(), "vot-local-"));
  const forgetTmp = onCleanup(() =>
    rmSync(tmp, { recursive: true, force: true }),
  );
  try {
    const audio = join(tmp, "audio.mp4");
    say("Извлекаю звук…");
    await run(extractAudioArgs(ffmpeg, file, audio));

    const server = serveFile(audio);
    const forgetServer = onCleanup(server.stop);
    let translationUrl: string;
    try {
      say("Открываю временный туннель…");
      const tunnel = await openTunnel(cloudflared, server.localUrl);
      try {
        const publicUrl = `${tunnel.url}${server.path}`;
        await waitReachable(publicUrl);
        say("Перевожу (сервер скачивает звук и озвучивает)…");
        translationUrl = await waitForTranslation(
          makeTranslate(options),
          {
            url: publicUrl,
            duration: info.duration,
            requestLang: options.requestLang,
            responseLang: options.responseLang,
            livelyVoice: options.livelyVoice,
          },
          {
            onWait: (sec, message) =>
              say(
                sec > 0
                  ? `  осталось примерно ${Math.ceil(sec / 60)} мин`
                  : `  ждём сервер…${message ? ` (${message})` : ""}`,
              ),
          },
        );
      } finally {
        tunnel.stop();
      }
    } finally {
      server.stop();
      forgetServer();
    }

    say("Скачиваю перевод…");
    const translation = join(tmp, "translation.mp3");
    await download(translationUrl, translation);

    say("Собираю видео с переводом…");
    await mux(
      {
        ffmpeg,
        video: file,
        translation,
        output: part,
        format: options.format,
        responseLang: options.responseLang,
        originalVolume: options.originalVolume,
      },
      info.mp4SafeVideo,
    );
    await rename(part, output);
    forgetPart();

    if (options.keepAudio) {
      const mp3 = `${output.slice(0, -extname(output).length)}.mp3`;
      await copyFile(translation, mp3);
    }
    say(`Готово: ${output}`);
    if (options.resultFile) {
      await writeFile(options.resultFile, output, "utf8").catch(
        (err: unknown) =>
          say(`Не удалось записать --result-file: ${errorMessage(err)}`),
      );
    }
    if (
      (options.open || options.openWith) &&
      !openResult(output, options.openWith)
    ) {
      throw new Error(`Перевод сохранён, но открыть его не удалось: ${output}`);
    }
  } finally {
    await rm(tmp, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    }).catch(() => {});
    forgetTmp();
    await rm(part, { force: true }).catch(() => {});
    forgetPart();
  }
}

async function importRegistry(content: string) {
  if (process.platform !== "win32") {
    throw new Error("Пункт меню можно добавить только в Windows");
  }
  if (basename(process.execPath).toLowerCase() !== "vot-local.exe") {
    throw new Error("Запустите install.cmd из папки VOT-local");
  }
  const tmp = await mkdtemp(join(tmpdir(), "vot-local-reg-"));
  try {
    const file = join(tmp, "menu.reg");
    await writeFile(file, encodeRegFile(content));
    await run(["reg", "import", file]);
  } catch (err) {
    throw new Error(`Не удалось изменить меню: ${errorMessage(err)}`);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let pause = argv.includes("--pause");
  let failed = 0;
  try {
    const command = parseCommand(argv);
    switch (command.kind) {
      case "help":
        if (!argv.length && process.platform === "win32") {
          say(NO_ARGS_HINT);
          pause = true;
        } else {
          say(HELP);
        }
        break;
      case "version":
        say(pkg.version);
        break;
      case "install": {
        const potplayer = command.potplayer ?? findPotPlayer();
        await importRegistry(installRegFile(process.execPath, potplayer));
        say("Подменю «VOT: закадровый перевод» добавлено в меню видеофайлов");
        say(
          potplayer
            ? `PotPlayer найден: ${potplayer}`
            : "PotPlayer не найден, пункт для него не добавлен",
        );
        break;
      }
      case "uninstall":
        await importRegistry(uninstallRegFile());
        say("Подменю удалено");
        break;
      case "translate":
        for (const file of command.files) {
          try {
            await translateFile(file, command.options);
          } catch (err) {
            failed++;
            say(`Ошибка (${basename(file)}): ${friendlyError(err)}`);
          }
        }
        pause = shouldPause(command.options, failed);
        break;
    }
  } catch (err) {
    failed++;
    pause ||= argv.includes("--pause-on-error");
    say(`Ошибка: ${friendlyError(err)}`);
  }

  if (pause) {
    prompt("Нажмите Enter, чтобы закрыть окно");
  }
  return failed ? 1 : 0;
}

useUtf8Console();
cleanupOnSignals();
process.exit(await main());
