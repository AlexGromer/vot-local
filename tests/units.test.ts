import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseCommand } from "../src/cli";
import { extractAudioArgs, parseProbe } from "../src/media";
import { isSubtitleError, muxArgs, outputPath } from "../src/mux";
import { findTool } from "../src/process";
import {
  installCommands,
  uninstallCommands,
  VIDEO_EXTENSIONS,
} from "../src/registry";
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
    expect(parseProbe(json)).toEqual({ duration: 90.603991, audioStreams: 2 });
  });

  test("fails without a duration", () => {
    expect(() => parseProbe("{}")).toThrow("длительность");
  });
});

describe("extractAudioArgs", () => {
  test("first audio stream to AAC in mp4", () => {
    const args = extractAudioArgs("ffmpeg", "in.mkv", "out.mp4");
    expect(args[0]).toBe("ffmpeg");
    expect(args).toContain("0:a:0");
    expect(args.slice(-1)).toEqual(["out.mp4"]);
    expect(args.join(" ")).toContain("-c:a aac -b:a 128k");
  });
});

describe("outputPath", () => {
  test("adds the language and avoids overwriting", () => {
    const dir = join("videos", "course");
    const taken = new Set([join(dir, "lesson.ru.mkv")]);
    expect(outputPath(join(dir, "lesson.mp4"), "ru", () => false)).toBe(
      join(dir, "lesson.ru.mkv"),
    );
    expect(outputPath(join(dir, "lesson.mp4"), "ru", (p) => taken.has(p))).toBe(
      join(dir, "lesson.ru-2.mkv"),
    );
  });
});

describe("muxArgs", () => {
  const base = {
    ffmpeg: "ffmpeg",
    video: "in.mp4",
    translation: "t.mp3",
    output: "out.mkv",
    responseLang: "ru" as const,
    originalVolume: 0.2,
  };

  test("dubbed track first, then every original track", () => {
    const args = muxArgs({ ...base, withSubtitles: true });
    const line = args.join(" ");
    expect(line).toContain(
      "[0:a:0]aformat=channel_layouts=stereo,volume=0.20[orig];[1:a:0]aformat=channel_layouts=stereo[tr];[orig][tr]amix=inputs=2:duration=first",
    );
    expect(line).toContain("-map 0:V? -map [dub] -map 0:a -map 0:s? -map 0:t?");
    expect(line).toContain("-c:v copy -c:a copy -c:a:0 aac -b:a:0 192k");
    expect(line).toContain("-metadata:s:a:0 language=rus");
    expect(line).toContain("-disposition:a 0 -disposition:a:0 default");
    expect(args.slice(-3)).toEqual(["-f", "matroska", "out.mkv"]);
  });

  test("without subtitles", () => {
    const line = muxArgs({ ...base, withSubtitles: false }).join(" ");
    expect(line).not.toContain("0:s?");
    expect(line).not.toContain("-c:s");
  });

  test("other languages", () => {
    const line = muxArgs({
      ...base,
      responseLang: "en",
      withSubtitles: false,
    }).join(" ");
    expect(line).toContain("language=eng");
    expect(line).toContain("title=VOT (en)");
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

describe("registry", () => {
  test("adds a menu entry with a command for every extension", () => {
    const exe = "C:\\Tools\\VOT\\vot-local.exe";
    const cmds = installCommands(exe);
    expect(cmds).toHaveLength(VIDEO_EXTENSIONS.length * 3);
    expect(cmds[0]).toEqual([
      "reg",
      "add",
      "HKCU\\Software\\Classes\\SystemFileAssociations\\.mp4\\shell\\vot-local",
      "/ve",
      "/d",
      "Перевести (VOT)",
      "/f",
    ]);
    expect(cmds[2]).toEqual([
      "reg",
      "add",
      "HKCU\\Software\\Classes\\SystemFileAssociations\\.mp4\\shell\\vot-local\\command",
      "/ve",
      "/d",
      '"C:\\Tools\\VOT\\vot-local.exe" --pause "%1"',
      "/f",
    ]);
  });

  test("removes the same keys", () => {
    const cmds = uninstallCommands();
    expect(cmds).toHaveLength(VIDEO_EXTENSIONS.length);
    expect(cmds[0]).toEqual([
      "reg",
      "delete",
      "HKCU\\Software\\Classes\\SystemFileAssociations\\.mp4\\shell\\vot-local",
      "/f",
    ]);
  });
});

describe("parseCommand", () => {
  test("defaults", () => {
    expect(parseCommand(["a.mp4"], {})).toEqual({
      kind: "translate",
      files: ["a.mp4"],
      options: {
        requestLang: "auto",
        responseLang: "ru",
        originalVolume: 0.2,
        livelyVoice: false,
        apiToken: undefined,
        keepAudio: false,
        pause: false,
      },
    });
  });

  test("subcommands and help", () => {
    expect(parseCommand([], {})).toEqual({ kind: "help" });
    expect(parseCommand(["install"], {})).toEqual({ kind: "install" });
    expect(parseCommand(["uninstall"], {})).toEqual({ kind: "uninstall" });
    expect(parseCommand(["-v"], {})).toEqual({ kind: "version" });
  });

  test("validates options", () => {
    expect(() => parseCommand(["--reslang", "de", "a.mp4"], {})).toThrow(
      "--reslang",
    );
    expect(() => parseCommand(["--lang", "xx", "a.mp4"], {})).toThrow("--lang");
    expect(() => parseCommand(["--original-volume", "2", "a.mp4"], {})).toThrow(
      "--original-volume",
    );
    expect(() => parseCommand(["--lively-voice", "a.mp4"], {})).toThrow(
      "VOT_API_TOKEN",
    );
  });

  test("lively voice token from env", () => {
    const cmd = parseCommand(["--lively-voice", "a.mp4"], {
      VOT_API_TOKEN: "t",
    });
    expect(cmd.kind === "translate" && cmd.options.apiToken).toBe("t");
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
