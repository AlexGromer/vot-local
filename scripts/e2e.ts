import { existsSync } from "node:fs";
import { join } from "node:path";
import { outputPath } from "../src/mux";
import { findTool, run } from "../src/process";

const video = process.argv[2];
if (!video || !existsSync(video)) {
  console.error("usage: bun scripts/e2e.ts <video with speech>");
  process.exit(2);
}

const output = outputPath(video, "ru");
const proc = Bun.spawn(
  ["bun", join(import.meta.dir, "..", "src", "main.ts"), video],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await proc.exited) !== 0) {
  throw new Error("vot-local failed");
}

const json = await run([
  findTool("ffprobe"),
  "-v",
  "error",
  "-print_format",
  "json",
  "-show_streams",
  output,
]);
const streams = (
  JSON.parse(json) as {
    streams: { codec_type: string; tags?: { title?: string } }[];
  }
).streams;
const audio = streams.filter((s) => s.codec_type === "audio");
if (audio.length !== 2 || audio[0]?.tags?.title !== "VOT (ru)") {
  throw new Error(`unexpected audio tracks in ${output}`);
}
console.log(`ok: ${output}`);
