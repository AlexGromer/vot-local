import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MuxOptions, muxArgs, type OutputFormat } from "../src/mux";
import { findTool, run } from "../src/process";

// Runs the real ffmpeg on generated media: a 3 s video with two audio tracks and a subtitle.
const ffmpeg = findTool("ffmpeg");
const ffprobe = findTool("ffprobe");
let dir: string;
let video: string;
let translation: string;

type Stream = {
  codec_type: string;
  codec_name: string;
  tags?: { title?: string; name?: string; language?: string };
  disposition?: { default?: number };
};

async function streams(file: string): Promise<Stream[]> {
  const json = await run([
    ffprobe,
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    file,
  ]);
  return (JSON.parse(json) as { streams: Stream[] }).streams;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vot-local-mux-"));
  video = join(dir, "in.mkv");
  translation = join(dir, "t.mp3");
  const srt = join(dir, "s.srt");
  await Bun.write(srt, "1\n00:00:00,000 --> 00:00:02,000\nhello\n");
  await run([
    ffmpeg,
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=160x90:rate=10:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=660:duration=3",
    "-i",
    srt,
    "-map",
    "0",
    "-map",
    "1",
    "-map",
    "2",
    "-map",
    "3",
    "-c:v",
    "mpeg4",
    "-c:a",
    "aac",
    "-c:s",
    "srt",
    video,
  ]);
  await run([
    ffmpeg,
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:duration=2",
    translation,
  ]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function opts(format: OutputFormat, output: string): MuxOptions {
  return {
    ffmpeg,
    video,
    translation,
    output,
    format,
    responseLang: "ru",
    originalVolume: 0.2,
    withSubtitles: true,
    reencodeVideo: false,
  };
}

describe("real ffmpeg mux", () => {
  test("mkv keeps video, dub, both originals and subtitles", async () => {
    const out = join(dir, "out.part");
    await run(muxArgs(opts("mkv", out)));
    const s = await streams(out);
    expect(s.map((x) => x.codec_type)).toEqual([
      "video",
      "audio",
      "audio",
      "audio",
      "subtitle",
    ]);
    expect(s[1]?.tags?.title).toBe("VOT (ru)");
    expect(s[1]?.disposition?.default).toBe(1);
    expect(s[2]?.disposition?.default).toBe(0);
  });

  test("mp4 has AAC tracks and no subtitles", async () => {
    const out = join(dir, "out-mp4.part");
    await run(muxArgs(opts("mp4", out)));
    const s = await streams(out);
    expect(s.map((x) => x.codec_type)).toEqual([
      "video",
      "audio",
      "audio",
      "audio",
    ]);
    expect(
      s
        .filter((x) => x.codec_type === "audio")
        .every((x) => x.codec_name === "aac"),
    ).toBe(true);
  });

  test("mp4 with re-encoded video", async () => {
    const out = join(dir, "out-mp4-re.part");
    await run(muxArgs({ ...opts("mp4", out), reencodeVideo: true }));
    const s = await streams(out);
    expect(s[0]?.codec_name).toBe("mpeg4");
  });

  test("m4a is the dub mix only", async () => {
    const out = join(dir, "out-m4a.part");
    await run(muxArgs(opts("m4a", out)));
    const s = await streams(out);
    expect(s).toHaveLength(1);
    expect(s[0]?.codec_type).toBe("audio");
    // mp4 stores the track title as the "name" tag, not "title".
    expect(s[0]?.tags?.language).toBe("rus");
    expect(s[0]?.tags?.name).toBe("VOT (ru)");
  });
});
