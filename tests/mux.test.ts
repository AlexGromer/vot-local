import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  firstAttempt,
  isSubtitleError,
  type MuxOptions,
  muxArgs,
  outputPath,
  retryAttempt,
} from "../src/mux";

const base: MuxOptions = {
  ffmpeg: "ffmpeg",
  video: "in.mp4",
  translation: "t.mp3",
  output: "out.part",
  format: "mkv",
  responseLang: "ru",
  originalVolume: 0.2,
  withSubtitles: true,
  reencodeVideo: false,
};

describe("outputPath", () => {
  const dir = join("videos", "course");

  test("adds language and format and avoids overwriting", () => {
    const taken = new Set([join(dir, "lesson.ru.mkv")]);
    expect(outputPath(join(dir, "lesson.mp4"), "ru", "mkv", () => false)).toBe(
      join(dir, "lesson.ru.mkv"),
    );
    expect(
      outputPath(join(dir, "lesson.mp4"), "ru", "mkv", (p) => taken.has(p)),
    ).toBe(join(dir, "lesson.ru-2.mkv"));
  });

  test("uses the format as extension", () => {
    expect(outputPath(join(dir, "a.avi"), "en", "mp4", () => false)).toBe(
      join(dir, "a.en.mp4"),
    );
    expect(outputPath(join(dir, "a.avi"), "ru", "m4a", () => false)).toBe(
      join(dir, "a.ru.m4a"),
    );
  });
});

describe("muxArgs mkv", () => {
  test("dubbed track first, then every original track", () => {
    const args = muxArgs(base);
    const line = args.join(" ");
    expect(line).toContain(
      "[0:a:0]aformat=channel_layouts=stereo,volume=0.20[orig];[1:a:0]aformat=channel_layouts=stereo[tr];[orig][tr]amix=inputs=2:duration=first",
    );
    expect(line).toContain("-map 0:V? -map [dub] -map 0:a -map 0:s? -map 0:t?");
    expect(line).toContain("-c:v copy -c:a copy -c:a:0 aac -b:a:0 192k");
    expect(line).toContain("-metadata:s:a:0 language=rus");
    expect(line).toContain("-disposition:a 0 -disposition:a:0 default");
    expect(args.slice(-3)).toEqual(["-f", "matroska", "out.part"]);
  });

  test("without subtitles", () => {
    const line = muxArgs({ ...base, withSubtitles: false }).join(" ");
    expect(line).not.toContain("0:s?");
    expect(line).not.toContain("-c:s");
  });

  test("other languages", () => {
    const line = muxArgs({ ...base, responseLang: "en" }).join(" ");
    expect(line).toContain("language=eng");
    expect(line).toContain("title=VOT (en)");
  });
});

describe("muxArgs mp4", () => {
  test("AAC for every track, no subtitles, faststart", () => {
    const args = muxArgs({ ...base, format: "mp4" });
    const line = args.join(" ");
    expect(line).toContain("-map 0:V? -map [dub] -map 0:a");
    expect(line).toContain("-c:v copy -c:a aac -b:a 192k -sn");
    expect(line).not.toContain("0:s?");
    expect(line).toContain("-disposition:a 0 -disposition:a:0 default");
    expect(args.slice(-5)).toEqual([
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "out.part",
    ]);
  });

  test("re-encodes video when asked", () => {
    const line = muxArgs({ ...base, format: "mp4", reencodeVideo: true }).join(
      " ",
    );
    expect(line).toContain("-c:v mpeg4 -q:v 3");
    expect(line).not.toContain("-c:v copy");
  });
});

describe("muxArgs m4a", () => {
  test("dubbed mix only, no video", () => {
    const args = muxArgs({ ...base, format: "m4a" });
    const line = args.join(" ");
    expect(line).toContain("-map [dub] -vn -c:a aac -b:a 192k");
    expect(line).not.toContain("0:V?");
    expect(line).not.toContain("title=Original");
    expect(args.slice(-3)).toEqual(["-f", "mp4", "out.part"]);
  });
});

describe("isSubtitleError", () => {
  test("detects subtitle and header errors only", () => {
    expect(
      isSubtitleError(
        "Subtitle codec 94213 is not supported.\nCould not write header for output file #0",
      ),
    ).toBe(true);
    expect(isSubtitleError("No space left on device")).toBe(false);
  });
});

describe("mux attempts", () => {
  const codecError = "Could not write header for output file #0";

  test("first attempt per format", () => {
    expect(firstAttempt("mkv", false)).toEqual({
      withSubtitles: true,
      reencodeVideo: false,
    });
    expect(firstAttempt("mp4", true)).toEqual({
      withSubtitles: false,
      reencodeVideo: false,
    });
    expect(firstAttempt("mp4", false).reencodeVideo).toBe(true);
    expect(firstAttempt("m4a", false)).toEqual({
      withSubtitles: false,
      reencodeVideo: false,
    });
  });

  test("retries only where it can help", () => {
    expect(retryAttempt("mkv", firstAttempt("mkv", true), codecError)).toEqual({
      withSubtitles: false,
      reencodeVideo: false,
    });
    expect(retryAttempt("mp4", firstAttempt("mp4", true), codecError)).toEqual({
      withSubtitles: false,
      reencodeVideo: true,
    });
    expect(
      retryAttempt("mp4", firstAttempt("mp4", false), codecError),
    ).toBeNull();
    expect(
      retryAttempt("m4a", firstAttempt("m4a", true), codecError),
    ).toBeNull();
    expect(
      retryAttempt("mkv", firstAttempt("mkv", true), "No space left on device"),
    ).toBeNull();
    expect(
      retryAttempt(
        "mkv",
        { withSubtitles: false, reencodeVideo: false },
        codecError,
      ),
    ).toBeNull();
  });
});
