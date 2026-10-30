import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { ResponseLang } from "@vot.js/shared/types/data";

const LANG_CODES: Record<ResponseLang, string> = {
  ru: "rus",
  en: "eng",
  kk: "kaz",
};

export const OUTPUT_FORMATS = ["mkv", "mp4", "m4a"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type MuxOptions = {
  ffmpeg: string;
  video: string;
  translation: string;
  output: string;
  format: OutputFormat;
  responseLang: ResponseLang;
  originalVolume: number;
  withSubtitles: boolean;
  reencodeVideo: boolean;
};

export function outputPath(
  input: string,
  responseLang: ResponseLang,
  format: OutputFormat = "mkv",
  exists: (path: string) => boolean = existsSync,
): string {
  const name = basename(input, extname(input));
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? "" : `-${i}`;
    const candidate = join(
      dirname(input),
      `${name}.${responseLang}${suffix}.${format}`,
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

export type MuxAttempt = Pick<MuxOptions, "withSubtitles" | "reencodeVideo">;

export function firstAttempt(
  format: OutputFormat,
  mp4SafeVideo: boolean,
): MuxAttempt {
  return {
    withSubtitles: format === "mkv",
    reencodeVideo: format === "mp4" && !mp4SafeVideo,
  };
}

// What to try after ffmpeg failed with this stderr, or null when a retry cannot help.
export function retryAttempt(
  format: OutputFormat,
  previous: MuxAttempt,
  stderr: string,
): MuxAttempt | null {
  if (format === "m4a" || !isSubtitleError(stderr)) {
    return null;
  }
  if (format === "mkv" && previous.withSubtitles) {
    return { withSubtitles: false, reencodeVideo: false };
  }
  if (format === "mp4" && !previous.reencodeVideo) {
    return { withSubtitles: false, reencodeVideo: true };
  }
  return null;
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
  const lang = LANG_CODES[opts.responseLang];
  const title = `VOT (${opts.responseLang})`;

  if (opts.format === "m4a") {
    args.push("-map", "[dub]", "-vn", "-c:a", "aac", "-b:a", "192k");
    args.push("-metadata:s:a:0", `language=${lang}`);
    args.push("-metadata:s:a:0", `title=${title}`);
    args.push("-f", "mp4", opts.output);
    return args;
  }

  args.push("-map", "0:V?", "-map", "[dub]", "-map", "0:a");
  const video = opts.reencodeVideo
    ? ["-c:v", "mpeg4", "-q:v", "3"]
    : ["-c:v", "copy"];

  if (opts.format === "mp4") {
    // Media Foundation players expect AAC in mp4, so the original tracks are re-encoded too.
    args.push(...video, "-c:a", "aac", "-b:a", "192k", "-sn");
  } else {
    if (opts.withSubtitles) {
      args.push("-map", "0:s?", "-map", "0:t?");
    }
    args.push(...video, "-c:a", "copy", "-c:a:0", "aac", "-b:a:0", "192k");
    if (opts.withSubtitles) {
      args.push("-c:s", "copy", "-c:t", "copy");
    }
  }

  args.push("-metadata:s:a:0", `language=${lang}`);
  args.push("-metadata:s:a:0", `title=${title}`);
  args.push("-metadata:s:a:1", "title=Original");
  args.push("-disposition:a", "0", "-disposition:a:0", "default");
  if (opts.format === "mp4") {
    args.push("-movflags", "+faststart", "-f", "mp4", opts.output);
  } else {
    args.push("-f", "matroska", opts.output);
  }
  return args;
}
