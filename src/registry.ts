import { existsSync } from "node:fs";
import { win32 } from "node:path";

export const VIDEO_EXTENSIONS = [
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".webm",
  ".m4v",
  ".wmv",
  ".flv",
  ".mpg",
  ".mpeg",
  ".3gp",
  ".m2ts",
  ".mts",
];

export const SETTINGS_KEY = "HKEY_CURRENT_USER\\Software\\vot-local";
const MENU_TITLE = "VOT: закадровый перевод";

export type Verb = { id: string; caption: string; args: string };

export function menuVerbs(potplayer: string | undefined): Verb[] {
  const verbs: Verb[] = [
    { id: "1translate", caption: "Перевести", args: "--pause" },
    {
      id: "2open",
      caption: "Перевести и открыть",
      args: "--pause-on-error --open",
    },
    {
      id: "3mediaplayer",
      caption: "Перевести для Медиаплеера Windows (mp4) и открыть",
      args: "--format mp4 --pause-on-error --open",
    },
  ];
  if (potplayer) {
    verbs.push({
      id: "4potplayer",
      caption: "Перевести и открыть в PotPlayer",
      args: `--pause-on-error --open-with ${quote(potplayer)}`,
    });
  }
  verbs.push({
    id: "5audio",
    caption: "Перевести только звук (m4a)",
    args: "--format m4a --pause",
  });
  return verbs;
}

function quote(value: string): string {
  return `"${value}"`;
}

function regString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function menuKey(ext: string): string {
  return `HKEY_CURRENT_USER\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\vot-local`;
}

function deletions(): string[] {
  return [
    ...VIDEO_EXTENSIONS.map((ext) => `[-${menuKey(ext)}]`),
    `[-${SETTINGS_KEY}]`,
  ];
}

export function installRegFile(exe: string, potplayer?: string): string {
  const lines = [
    "Windows Registry Editor Version 5.00",
    "",
    ...deletions(),
    "",
  ];
  for (const ext of VIDEO_EXTENSIONS) {
    const key = menuKey(ext);
    lines.push(`[${key}]`);
    lines.push(`"MUIVerb"=${regString(MENU_TITLE)}`);
    lines.push(`"SubCommands"=""`);
    lines.push(`"Icon"=${regString(exe)}`, "");
    for (const verb of menuVerbs(potplayer)) {
      lines.push(`[${key}\\shell\\${verb.id}]`);
      lines.push(`@=${regString(verb.caption)}`, "");
      lines.push(`[${key}\\shell\\${verb.id}\\command]`);
      lines.push(`@=${regString(`${quote(exe)} ${verb.args} "%1"`)}`, "");
    }
  }
  lines.push(`[${SETTINGS_KEY}]`);
  lines.push(`"InstallPath"=${regString(win32.dirname(exe))}`);
  if (potplayer) {
    lines.push(`"PotPlayer"=${regString(potplayer)}`);
  }
  lines.push("");
  return lines.join("\r\n");
}

export function uninstallRegFile(): string {
  return ["Windows Registry Editor Version 5.00", "", ...deletions(), ""].join(
    "\r\n",
  );
}

export function encodeRegFile(text: string): Uint8Array {
  // regedit/reg import expects UTF-16LE with a BOM for non-ASCII text.
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes[2 + i * 2] = code & 0xff;
    bytes[3 + i * 2] = code >> 8;
  }
  return bytes;
}

export function findPotPlayer(
  env: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const candidates: string[] = [];
  for (const root of [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.ProgramW6432,
  ]) {
    if (!root) {
      continue;
    }
    for (const dir of ["DAUM\\PotPlayer", "Kakao\\PotPlayer"]) {
      candidates.push(win32.join(root, dir, "PotPlayerMini64.exe"));
      candidates.push(win32.join(root, dir, "PotPlayerMini.exe"));
    }
  }
  return candidates.find((path) => exists(path));
}
