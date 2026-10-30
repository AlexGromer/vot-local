import { describe, expect, test } from "bun:test";
import { extractAudioArgs, parseProbe } from "../src/media";
import { findTool } from "../src/process";
import { findTunnelUrl, readyTunnelUrl, tunnelError } from "../src/tunnel";

describe("findTunnelUrl", () => {
  test("picks the quick tunnel url from cloudflared logs", () => {
    const log = [
      "2026-10-29T21:16:40Z INF Requesting new quick Tunnel on trycloudflare.com...",
      "2026-10-29T21:16:44Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |",
      "2026-10-29T21:16:44Z INF |  https://return-tennis-object-improving.trycloudflare.com                                 |",
    ].join("\n");
    expect(findTunnelUrl(log)).toBe(
      "https://return-tennis-object-improving.trycloudflare.com",
    );
  });

  test("ignores the api host and missing urls", () => {
    expect(
      findTunnelUrl(
        'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"',
      ),
    ).toBeUndefined();
    expect(findTunnelUrl("INF Starting tunnel")).toBeUndefined();
  });

  test("ready only after the edge connection is registered", () => {
    const created =
      "INF |  https://return-tennis-object-improving.trycloudflare.com  |";
    expect(readyTunnelUrl(created)).toBeUndefined();
    expect(
      readyTunnelUrl(
        `${created}\nINF Registered tunnel connection connIndex=0 event=0`,
      ),
    ).toBe("https://return-tennis-object-improving.trycloudflare.com");
  });
});

describe("tunnelError", () => {
  test("rate limit, timeout and generic failure", () => {
    expect(tunnelError("ERR status 429 Too Many Requests", false)).toContain(
      "ограничил",
    );
    expect(tunnelError("", true)).toContain("за 90 с");
    expect(tunnelError("ERR dial tcp: i/o timeout", false)).toContain(
      "ERR dial tcp: i/o timeout",
    );
  });
});

describe("parseProbe", () => {
  test("reads duration and audio stream count", () => {
    const json = JSON.stringify({
      format: { duration: "90.603991" },
      streams: [
        { codec_type: "video" },
        { codec_type: "audio" },
        { codec_type: "audio" },
        { codec_type: "subtitle" },
      ],
    });
    expect(parseProbe(json)).toEqual({
      duration: 90.603991,
      audioStreams: 2,
      mp4SafeVideo: false,
    });
  });

  test("fails without a duration", () => {
    expect(() => parseProbe("{}")).toThrow("длительность");
    expect(() => parseProbe("[]")).toThrow("длительность");
  });
});

describe("extractAudioArgs", () => {
  test("first audio stream to AAC in mp4 without metadata", () => {
    const args = extractAudioArgs("ffmpeg", "in.mkv", "out.mp4");
    const line = args.join(" ");
    expect(args[0]).toBe("ffmpeg");
    expect(line).toContain("-map 0:a:0 -map_metadata -1 -map_chapters -1");
    expect(line).toContain("-c:a aac -b:a 128k");
    expect(args.at(-1)).toBe("out.mp4");
  });
});

describe("findTool", () => {
  test("falls back to PATH and reports a missing tool", () => {
    expect(findTool("ffmpeg", "/nonexistent", () => "/usr/bin/ffmpeg")).toBe(
      "/usr/bin/ffmpeg",
    );
    expect(() => findTool("cloudflared", "/nonexistent", () => null)).toThrow(
      "Не найден",
    );
  });
});

describe("parseProbe mp4SafeVideo", () => {
  const probeOf = (streams: unknown[]) =>
    parseProbe(JSON.stringify({ format: { duration: "10" }, streams }));

  test("8-bit 4:2:0 H.264 or no video is safe", () => {
    expect(
      probeOf([{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" }])
        .mp4SafeVideo,
    ).toBe(true);
    expect(probeOf([{ codec_type: "audio" }]).mp4SafeVideo).toBe(true);
  });

  test("other codecs and 10-bit need re-encoding; cover art is ignored", () => {
    for (const video of [
      { codec_name: "hevc", pix_fmt: "yuv420p" },
      { codec_name: "vp9", pix_fmt: "yuv420p" },
      { codec_name: "h264", pix_fmt: "yuv420p10le" },
    ]) {
      expect(probeOf([{ codec_type: "video", ...video }]).mp4SafeVideo).toBe(
        false,
      );
    }
    expect(
      probeOf([
        {
          codec_type: "video",
          codec_name: "mjpeg",
          disposition: { attached_pic: 1 },
        },
      ]).mp4SafeVideo,
    ).toBe(true);
  });
});
