import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { ResponseLang } from "@vot.js/shared/types/data";

const LANG_CODES: Record<ResponseLang, string> = {
  ru: "rus",
  en: "eng",
  kk: "kaz",
};

export type MuxOptions = {
  ffmpeg: string;
  video: string;
  translation: string;
  output: string;
  responseLang: ResponseLang;
  originalVolume: number;
  withSubtitles: boolean;
};

export function outputPath(
  input: string,
  responseLang: ResponseLang,
  exists: (path: string) => boolean = existsSync,
): string {
  const name = basename(input, extname(input));
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? "" : `-${i}`;
    const candidate = join(
      dirname(input),
      `${name}.${responseLang}${suffix}.mkv`,
    );
    if (!exists(candidate)) {
      return candidate;
    }
  }
}

export function isSubtitleError(stderr: string): boolean {
  return /subtitle|codec not currently supported|not supported|Could not write header|incompatible/i.test(
    stderr,
  );
}

export function muxArgs(opts: MuxOptions): string[] {
  const volume = opts.originalVolume.toFixed(2);
  const args = [opts.ffmpeg, "-v", "error", "-y"];
  args.push("-i", opts.video, "-i", opts.translation);
  // Both inputs go to stereo first, otherwise a 5.1 original keeps the dub in front L/R only.
  args.push(
    "-filter_complex",
    `[0:a:0]aformat=channel_layouts=stereo,volume=${volume}[orig];` +
      "[1:a:0]aformat=channel_layouts=stereo[tr];" +
      "[orig][tr]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[dub]",
  );
  args.push("-map", "0:V?", "-map", "[dub]", "-map", "0:a");
  if (opts.withSubtitles) {
    args.push("-map", "0:s?", "-map", "0:t?");
  }

  args.push("-c:v", "copy", "-c:a", "copy", "-c:a:0", "aac", "-b:a:0", "192k");
  if (opts.withSubtitles) {
    args.push("-c:s", "copy", "-c:t", "copy");
  }

  args.push("-metadata:s:a:0", `language=${LANG_CODES[opts.responseLang]}`);
  args.push("-metadata:s:a:0", `title=VOT (${opts.responseLang})`);
  args.push("-metadata:s:a:1", "title=Original");
  args.push("-disposition:a", "0", "-disposition:a:0", "default");
  args.push("-f", "matroska", opts.output);
  return args;
}
