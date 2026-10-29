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

const MENU_TITLE = "Перевести (VOT)";

function menuKey(ext: string): string {
  return `HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\vot-local`;
}

export function installCommands(exe: string): string[][] {
  return VIDEO_EXTENSIONS.flatMap((ext) => {
    const key = menuKey(ext);
    return [
      ["reg", "add", key, "/ve", "/d", MENU_TITLE, "/f"],
      ["reg", "add", key, "/v", "Icon", "/d", exe, "/f"],
      [
        "reg",
        "add",
        `${key}\\command`,
        "/ve",
        "/d",
        `"${exe}" --pause "%1"`,
        "/f",
      ],
    ];
  });
}

export function uninstallCommands(): string[][] {
  return VIDEO_EXTENSIONS.map((ext) => ["reg", "delete", menuKey(ext), "/f"]);
}
