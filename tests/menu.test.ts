import { describe, expect, test } from "bun:test";
import {
  encodeRegFile,
  findPotPlayer,
  installRegFile,
  menuVerbs,
  uninstallRegFile,
  VIDEO_EXTENSIONS,
} from "../src/registry";

const exe = "C:\\Tools\\VOT-local\\vot-local.exe";
const pot = "C:\\Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe";
const key =
  "HKEY_CURRENT_USER\\Software\\Classes\\SystemFileAssociations\\.mp4\\shell\\vot-local";

describe("menuVerbs", () => {
  test("PotPlayer entry only when it is found", () => {
    expect(menuVerbs(undefined).map((v) => v.id)).toEqual([
      "1translate",
      "2open",
      "3mediaplayer",
      "5audio",
    ]);
    const withPot = menuVerbs(pot);
    expect(withPot.map((v) => v.id)).toContain("4potplayer");
    expect(withPot.find((v) => v.id === "4potplayer")?.args).toBe(
      `--pause-on-error --open-with "${pot}"`,
    );
  });

  test("media player verb asks for mp4", () => {
    expect(
      menuVerbs(undefined).find((v) => v.id === "3mediaplayer")?.args,
    ).toBe("--format mp4 --pause-on-error --open");
  });
});

describe("installRegFile", () => {
  const reg = installRegFile(exe, pot);
  const lines = reg.split("\r\n");

  test("removes old keys first, then adds a cascading submenu", () => {
    expect(lines[0]).toBe("Windows Registry Editor Version 5.00");
    const firstDelete = lines.indexOf(`[-${key}]`);
    const firstAdd = lines.indexOf(`[${key}]`);
    expect(firstDelete).toBeGreaterThan(0);
    expect(firstAdd).toBeGreaterThan(firstDelete);
    expect(lines[firstAdd + 1]).toBe('"MUIVerb"="VOT: закадровый перевод"');
    expect(lines[firstAdd + 2]).toBe('"SubCommands"=""');
    expect(lines[firstAdd + 3]).toBe(
      '"Icon"="C:\\\\Tools\\\\VOT-local\\\\vot-local.exe"',
    );
  });

  test("escapes the command line", () => {
    const at = lines.indexOf(`[${key}\\shell\\4potplayer\\command]`);
    expect(lines[at + 1]).toBe(
      '@="\\"C:\\\\Tools\\\\VOT-local\\\\vot-local.exe\\" --pause-on-error --open-with \\"C:\\\\Program Files\\\\DAUM\\\\PotPlayer\\\\PotPlayerMini64.exe\\" \\"%1\\""',
    );
  });

  test("every extension gets every verb, settings are stored", () => {
    const commands = lines.filter((l) => l.endsWith("\\command]"));
    expect(commands).toHaveLength(VIDEO_EXTENSIONS.length * 5);
    expect(reg).toContain('"InstallPath"="C:\\\\Tools\\\\VOT-local"');
    expect(reg).toContain('"PotPlayer"=');
    expect(installRegFile(exe)).not.toContain("PotPlayer");
  });
});

describe("uninstallRegFile", () => {
  test("only deletions", () => {
    const lines = uninstallRegFile().split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(1 + VIDEO_EXTENSIONS.length + 1);
    expect(lines.slice(1).every((l) => l.startsWith("[-"))).toBe(true);
  });
});

describe("encodeRegFile", () => {
  test("UTF-16LE with BOM", () => {
    const bytes = encodeRegFile("Пе");
    expect([...bytes]).toEqual([0xff, 0xfe, 0x1f, 0x04, 0x35, 0x04]);
  });
});

describe("findPotPlayer", () => {
  test("checks the usual install folders", () => {
    const x86 = "C:\\Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini.exe";
    const env = {
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    };
    expect(findPotPlayer(env, (p) => p === x86)).toBe(x86);
    expect(findPotPlayer(env, (p) => p === pot)).toBe(pot);
    expect(findPotPlayer(env, () => false)).toBeUndefined();
    expect(findPotPlayer({}, () => true)).toBeUndefined();
  });
});

describe("registry edge cases", () => {
  test("characters outside the BMP become surrogate pairs", () => {
    expect([...encodeRegFile("😀")]).toEqual([
      0xff, 0xfe, 0x3d, 0xd8, 0x00, 0xde,
    ]);
  });

  test("PotPlayer from ProgramW6432 and the Kakao folder", () => {
    const kakao = "D:\\Apps\\Kakao\\PotPlayer\\PotPlayerMini64.exe";
    expect(
      findPotPlayer({ ProgramW6432: "D:\\Apps" }, (p) => p === kakao),
    ).toBe(kakao);
  });

  test("audio verb asks for m4a and pauses", () => {
    expect(menuVerbs(undefined).find((v) => v.id === "5audio")?.args).toBe(
      "--format m4a --pause",
    );
  });
});
