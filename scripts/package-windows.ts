import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../package.json";

const root = join(import.meta.dir, "..");
const vendor = join(root, "vendor", "windows");
const out = join(root, "dist", "VOT-local");
const zip = join(root, "dist", "vot-local-windows.zip");

const tools = ["ffmpeg.exe", "ffprobe.exe", "cloudflared.exe"];
const vendorLicenses = [
  "ffmpeg-LICENSE.txt",
  "cloudflared-LICENSE.txt",
  "bun-LICENSE.md",
];

const installCmd = `@echo off
"%~dp0vot-local.exe" install
pause
`;

const uninstallCmd = `@echo off
"%~dp0vot-local.exe" uninstall
pause
`;

function windowsText(text: string): string {
  return `﻿${text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n")}`;
}

async function sh(cmd: string[], cwd = root) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) {
    throw new Error(`${cmd.join(" ")} failed`);
  }
}

type PackageJson = {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
};

async function thirdPartyNotices(): Promise<string> {
  const seen = new Map<string, PackageJson & { dir: string }>();
  const visit = async (name: string) => {
    const dir = join(root, "node_modules", name);
    if (seen.has(name) || !existsSync(dir)) {
      return;
    }
    const meta = (await Bun.file(
      join(dir, "package.json"),
    ).json()) as PackageJson;
    seen.set(name, { ...meta, dir });
    for (const dep of Object.keys(meta.dependencies ?? {})) {
      await visit(dep);
    }
  };
  for (const dep of Object.keys(pkg.dependencies)) {
    await visit(dep);
  }

  const parts = [
    "vot-local.exe bundles the Bun runtime (see bun-LICENSE.md) and these npm packages:",
  ];
  for (const meta of [...seen.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const files = await readdir(meta.dir);
    const license = files.find((f) => /^licen[sc]e/i.test(f));
    const text = license
      ? await Bun.file(join(meta.dir, license)).text()
      : `License: ${meta.license ?? "unknown"}`;
    parts.push(`\n===== ${meta.name}@${meta.version} =====\n\n${text.trim()}`);
  }
  return `${parts.join("\n")}\n`;
}

if (!Bun.which("zip")) {
  throw new Error("zip is required to build the package");
}
for (const file of [...tools, ...vendorLicenses]) {
  if (!existsSync(join(vendor, file))) {
    throw new Error(`missing vendor/windows/${file}`);
  }
}

await rm(out, { recursive: true, force: true });
await rm(zip, { force: true });
await mkdir(join(out, "licenses"), { recursive: true });

await sh([
  "bun",
  "build",
  "src/main.ts",
  "--compile",
  "--target=bun-windows-x64",
  "--outfile",
  join(out, "vot-local.exe"),
]);

for (const file of tools) {
  await copyFile(join(vendor, file), join(out, file));
}
for (const file of vendorLicenses) {
  await copyFile(join(vendor, file), join(out, "licenses", file));
}
await copyFile(
  join(root, "LICENSE"),
  join(out, "licenses", "vot-local-LICENSE.txt"),
);
await copyFile(
  join(root, "docs", "FFmpeg-SOURCE.txt"),
  join(out, "licenses", "FFmpeg-SOURCE.txt"),
);
await writeFile(
  join(out, "licenses", "THIRD-PARTY-NOTICES.txt"),
  await thirdPartyNotices(),
);
await writeFile(
  join(out, "README.txt"),
  windowsText(await Bun.file(join(root, "docs", "README-RU.txt")).text()),
);
await writeFile(join(out, "install.cmd"), installCmd.replaceAll("\n", "\r\n"));
await writeFile(
  join(out, "uninstall.cmd"),
  uninstallCmd.replaceAll("\n", "\r\n"),
);

const sums: string[] = [];
async function hashDir(dir: string, prefix = "") {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await hashDir(path, rel);
    } else {
      const hash = createHash("sha256")
        .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
        .digest("hex");
      sums.push(`${hash}  ${rel}`);
    }
  }
}
await hashDir(out);
await writeFile(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);

await sh(["zip", "-q", "-r", zip, "VOT-local"], join(root, "dist"));
console.log(zip);
