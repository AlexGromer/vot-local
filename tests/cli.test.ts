import { describe, expect, test } from "bun:test";
import { parseCommand, shouldPause, type TranslateOptions } from "../src/cli";

describe("parseCommand", () => {
  test("defaults", () => {
    expect(parseCommand(["a.mp4"], {})).toEqual({
      kind: "translate",
      files: ["a.mp4"],
      options: {
        requestLang: "auto",
        responseLang: "ru",
        format: "mkv",
        originalVolume: 0.2,
        livelyVoice: false,
        apiToken: undefined,
        keepAudio: false,
        pause: false,
        pauseOnError: false,
        open: false,
        openWith: undefined,
        resultFile: undefined,
      },
    });
  });

  test("player integration options", () => {
    const cmd = parseCommand(
      [
        "--format",
        "m4a",
        "--open-with",
        "C:\\P\\PotPlayerMini64.exe",
        "--result-file",
        "r.txt",
        "--pause-on-error",
        "--open",
        "a.mkv",
      ],
      {},
    );
    expect(cmd.kind).toBe("translate");
    if (cmd.kind === "translate") {
      expect(cmd.options.format).toBe("m4a");
      expect(cmd.options.openWith).toBe("C:\\P\\PotPlayerMini64.exe");
      expect(cmd.options.resultFile).toBe("r.txt");
      expect(cmd.options.pauseOnError).toBe(true);
      expect(cmd.options.open).toBe(true);
    }
  });

  test("subcommands and help", () => {
    expect(parseCommand([], {})).toEqual({ kind: "help" });
    expect(parseCommand(["install"], {})).toEqual({
      kind: "install",
      potplayer: undefined,
    });
    expect(parseCommand(["install", "--potplayer", "C:\\p.exe"], {})).toEqual({
      kind: "install",
      potplayer: "C:\\p.exe",
    });
    expect(parseCommand(["uninstall"], {})).toEqual({ kind: "uninstall" });
    expect(parseCommand(["-v"], {})).toEqual({ kind: "version" });
  });

  test("validates options", () => {
    expect(() => parseCommand(["--reslang", "de", "a.mp4"], {})).toThrow(
      "--reslang",
    );
    expect(() => parseCommand(["--lang", "xx", "a.mp4"], {})).toThrow("--lang");
    expect(() => parseCommand(["--format", "avi", "a.mp4"], {})).toThrow(
      "--format",
    );
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

describe("strict arguments", () => {
  test("install and uninstall take no files", () => {
    expect(() => parseCommand(["install", "a.mp4"], {})).toThrow("лишние");
    expect(() => parseCommand(["uninstall", "x"], {})).toThrow("лишние");
  });

  test("--potplayer only with install", () => {
    expect(() => parseCommand(["--potplayer", "p.exe", "a.mp4"], {})).toThrow(
      "install",
    );
  });

  test("empty --original-volume is rejected", () => {
    expect(() => parseCommand(["--original-volume", "", "a.mp4"], {})).toThrow(
      "--original-volume",
    );
  });
});

describe("shouldPause", () => {
  const cmd = parseCommand(["a.mp4"], {});
  const base = (
    cmd.kind === "translate" ? cmd.options : null
  ) as TranslateOptions;

  test("pause always, on error only, or never", () => {
    expect(shouldPause({ ...base, pause: true }, 0)).toBe(true);
    expect(shouldPause({ ...base, pauseOnError: true }, 0)).toBe(false);
    expect(shouldPause({ ...base, pauseOnError: true }, 1)).toBe(true);
    expect(shouldPause(base, 1)).toBe(false);
  });
});
