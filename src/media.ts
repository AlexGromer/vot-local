import { run } from "./process";

export type MediaInfo = {
  duration: number;
  audioStreams: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseProbe(json: string): MediaInfo {
  const data: unknown = JSON.parse(json);
  const format = isRecord(data) && isRecord(data.format) ? data.format : {};
  const duration = Number(format.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(
      "Не удалось прочитать длительность: файл повреждён или это не видео",
    );
  }

  const streams =
    isRecord(data) && Array.isArray(data.streams) ? data.streams : [];
  const audioStreams = streams.filter(
    (stream: unknown) => isRecord(stream) && stream.codec_type === "audio",
  ).length;
  return { duration, audioStreams };
}

export async function probe(ffprobe: string, file: string): Promise<MediaInfo> {
  const json = await run([
    ffprobe,
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  return parseProbe(json);
}

export function extractAudioArgs(
  ffmpeg: string,
  input: string,
  output: string,
): string[] {
  // Re-encoding keeps any source codec (AC3, DTS, Opus…) readable for the translation backend.
  return [
    ffmpeg,
    "-v",
    "error",
    "-y",
    "-i",
    input,
    "-map",
    "0:a:0",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-vn",
    "-sn",
    "-dn",
    "-ac",
    "2",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    output,
  ];
}
