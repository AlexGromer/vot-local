import { parseArgs } from "node:util";
import { availableLangs, availableTTS } from "@vot.js/shared/consts";
import type { RequestLang, ResponseLang } from "@vot.js/shared/types/data";
import { OUTPUT_FORMATS, type OutputFormat } from "./mux";

export type Command =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "install"; potplayer: string | undefined }
  | { kind: "uninstall" }
  | { kind: "translate"; files: string[]; options: TranslateOptions };

export type TranslateOptions = {
  requestLang: RequestLang;
  responseLang: ResponseLang;
  format: OutputFormat;
  originalVolume: number;
  livelyVoice: boolean;
  apiToken: string | undefined;
  keepAudio: boolean;
  pause: boolean;
  pauseOnError: boolean;
  open: boolean;
  openWith: string | undefined;
  resultFile: string | undefined;
};

export const HELP = `vot-local — translate local video files with Yandex voice-over translation

Usage:
  vot-local [options] <video> [video2 ...]
  vot-local install [--potplayer <exe>]   add the "VOT" submenu to the Explorer context menu (Windows)
  vot-local uninstall                     remove it

Options:
  --lang <code>              source language (default: auto)
  --reslang <code>           translation language: ru, en, kk (default: ru)
  --format <mkv|mp4|m4a>     mkv: video + dub + original tracks (default)
                             mp4: H.264/AAC-friendly file for Windows Media Player / Media Foundation
                             m4a: dubbed audio only, for audio players such as AIMP
  --original-volume <0..1>   original audio level under the translation (default: 0.2)
  --lively-voice             use lively voices (needs VOT_API_TOKEN or --api-token)
  --api-token <token>        Yandex OAuth token for lively voices
  --keep-audio               also keep the translation as <name>.<lang>.mp3
  --open                     open the result in the default app when done
  --open-with <exe>          open the result with this program when done
  --result-file <path>       write the path of the result to this file (UTF-8)
  --pause                    wait for Enter before exiting
  --pause-on-error           wait for Enter only if something failed
  -h, --help                 show this help
  -v, --version              show version

The audio track is served to the translation backend through a temporary
Cloudflare quick tunnel while the translation runs. The result is written
next to the video as <name>.<lang>.<format> with the dubbed track first.`;

function isRequestLang(value: string): value is RequestLang {
  return (availableLangs as readonly string[]).includes(value);
}

function isResponseLang(value: string): value is ResponseLang {
  return (availableTTS as readonly string[]).includes(value);
}

function isOutputFormat(value: string): value is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
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
      format: { type: "string", default: "mkv" },
      "original-volume": { type: "string", default: "0.2" },
      "lively-voice": { type: "boolean", default: false },
      "api-token": { type: "string" },
      "keep-audio": { type: "boolean", default: false },
      open: { type: "boolean", default: false },
      "open-with": { type: "string" },
      "result-file": { type: "string" },
      potplayer: { type: "string" },
      pause: { type: "boolean", default: false },
      "pause-on-error": { type: "boolean", default: false },
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
  const [first] = positionals;
  if (first === "install" || first === "uninstall") {
    if (positionals.length > 1) {
      throw new Error(`${first}: лишние аргументы`);
    }
    return first === "install"
      ? { kind: "install", potplayer: values.potplayer }
      : { kind: "uninstall" };
  }
  if (values.potplayer !== undefined) {
    throw new Error("--potplayer используется только с install");
  }
  if (!positionals.length) {
    return { kind: "help" };
  }

  const requestLang = values.lang;
  if (!isRequestLang(requestLang)) {
    throw new Error(`--lang: допустимо ${availableLangs.join(", ")}`);
  }

  const responseLang = values.reslang;
  if (!isResponseLang(responseLang)) {
    throw new Error(`--reslang: допустимо ${availableTTS.join(", ")}`);
  }

  const format = values.format;
  if (!isOutputFormat(format)) {
    throw new Error(`--format: допустимо ${OUTPUT_FORMATS.join(", ")}`);
  }

  const volumeText = values["original-volume"].trim();
  const originalVolume = volumeText ? Number(volumeText) : Number.NaN;
  if (
    !Number.isFinite(originalVolume) ||
    originalVolume < 0 ||
    originalVolume > 1
  ) {
    throw new Error("--original-volume: нужно число от 0 до 1");
  }

  const apiToken = values["api-token"] ?? env.VOT_API_TOKEN;
  if (values["lively-voice"] && !apiToken) {
    throw new Error("--lively-voice: нужен --api-token или VOT_API_TOKEN");
  }

  return {
    kind: "translate",
    files: positionals,
    options: {
      requestLang,
      responseLang,
      format,
      originalVolume,
      livelyVoice: values["lively-voice"],
      apiToken,
      keepAudio: values["keep-audio"],
      pause: values.pause,
      pauseOnError: values["pause-on-error"],
      open: values.open,
      openWith: values["open-with"],
      resultFile: values["result-file"],
    },
  };
}

export function shouldPause(
  options: TranslateOptions,
  failed: number,
): boolean {
  return options.pause || (options.pauseOnError && failed > 0);
}
