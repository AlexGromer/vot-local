import { parseArgs } from "node:util";
import { availableLangs, availableTTS } from "@vot.js/shared/consts";
import type { RequestLang, ResponseLang } from "@vot.js/shared/types/data";

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "install" }
  | { kind: "uninstall" }
  | { kind: "translate"; files: string[]; options: TranslateOptions };

export type TranslateOptions = {
  requestLang: RequestLang;
  responseLang: ResponseLang;
  originalVolume: number;
  livelyVoice: boolean;
  apiToken: string | undefined;
  keepAudio: boolean;
  pause: boolean;
};

export const HELP = `vot-local — translate local video files with Yandex voice-over translation

Usage:
  vot-local [options] <video> [video2 ...]
  vot-local install      add "Перевести (VOT)" to the Explorer context menu (Windows)
  vot-local uninstall    remove it

Options:
  --lang <code>              source language (default: auto)
  --reslang <code>           translation language: ru, en, kk (default: ru)
  --original-volume <0..1>   original audio level under the translation (default: 0.2)
  --lively-voice             use lively voices (needs VOT_API_TOKEN or --api-token)
  --api-token <token>        Yandex OAuth token for lively voices
  --keep-audio               also keep the translation as <name>.<lang>.mp3
  --pause                    wait for Enter before exiting
  -h, --help                 show this help
  -v, --version              show version

The audio track is served to the translation backend through a temporary
Cloudflare quick tunnel while the translation runs. The result is written
next to the video as <name>.<lang>.mkv with the dubbed track first.`;

function isRequestLang(value: string): value is RequestLang {
  return (availableLangs as readonly string[]).includes(value);
}

function isResponseLang(value: string): value is ResponseLang {
  return (availableTTS as readonly string[]).includes(value);
}

export function parseCommand(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Command {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      lang: { type: "string", default: "auto" },
      reslang: { type: "string", default: "ru" },
      "original-volume": { type: "string", default: "0.2" },
      "lively-voice": { type: "boolean", default: false },
      "api-token": { type: "string" },
      "keep-audio": { type: "boolean", default: false },
      pause: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (values.help) {
    return { kind: "help" };
  }
  if (values.version) {
    return { kind: "version" };
  }
  if (positionals.length === 1 && positionals[0] === "install") {
    return { kind: "install" };
  }
  if (positionals.length === 1 && positionals[0] === "uninstall") {
    return { kind: "uninstall" };
  }
  if (!positionals.length) {
    return { kind: "help" };
  }

  const requestLang = values.lang;
  if (!isRequestLang(requestLang)) {
    throw new Error(`--lang must be one of: ${availableLangs.join(", ")}`);
  }

  const responseLang = values.reslang;
  if (!isResponseLang(responseLang)) {
    throw new Error(`--reslang must be one of: ${availableTTS.join(", ")}`);
  }

  const originalVolume = Number(values["original-volume"]);
  if (
    !Number.isFinite(originalVolume) ||
    originalVolume < 0 ||
    originalVolume > 1
  ) {
    throw new Error("--original-volume must be a number from 0 to 1");
  }

  const apiToken = values["api-token"] ?? env.VOT_API_TOKEN;
  if (values["lively-voice"] && !apiToken) {
    throw new Error("--lively-voice needs --api-token or VOT_API_TOKEN");
  }

  return {
    kind: "translate",
    files: positionals,
    options: {
      requestLang,
      responseLang,
      originalVolume,
      livelyVoice: values["lively-voice"],
      apiToken,
      keepAudio: values["keep-audio"],
      pause: values.pause,
    },
  };
}
