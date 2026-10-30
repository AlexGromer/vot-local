import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

// The AIMP SDK is downloaded, not vendored: its headers are not ours to redistribute.
const SDK_URL = "https://aimp.ru/?do=download.file&id=15";
const SDK_SHA256 =
  "aa449fed93b93af7880a5580d71265231d048115e837b8d79f0c32aec59537a7";

const root = join(import.meta.dir, "..");
const cache = join(root, "vendor", "aimp-sdk");
const out = join(root, "dist", "aimp");
const pack = join(out, "pack", "vot_local");

const llvmMingw = process.env.LLVM_MINGW;
if (!llvmMingw || !existsSync(join(llvmMingw, "bin"))) {
  throw new Error("set LLVM_MINGW to an llvm-mingw toolchain directory");
}

async function sh(cmd: string[], cwd = root) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) {
    throw new Error(`${cmd[0]} failed`);
  }
}

async function sdkHeaders(): Promise<string> {
  const headers = join(cache, "Sources", "Cpp");
  if (existsSync(join(headers, "apiPlugin.h"))) {
    return headers;
  }
  const res = await fetch(SDK_URL);
  if (!res.ok) {
    throw new Error(`AIMP SDK download failed: HTTP ${res.status}`);
  }
  const zip = new Uint8Array(await res.arrayBuffer());
  const hash = createHash("sha256").update(zip).digest("hex");
  if (hash !== SDK_SHA256) {
    throw new Error(`AIMP SDK checksum mismatch: ${hash}`);
  }
  await mkdir(cache, { recursive: true });
  const file = join(cache, "aimp-sdk.zip");
  await Bun.write(file, zip);
  await sh(["unzip", "-q", "-o", file, "-d", cache]);
  return headers;
}

const headers = await sdkHeaders();
await rm(out, { recursive: true, force: true });
await mkdir(join(pack, "x64"), { recursive: true });

const common = [
  "-std=c++17",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-shared",
  "-static",
  "-isystem",
  headers,
  join(root, "plugins", "aimp", "vot_local.cpp"),
  "-ladvapi32",
  "-luser32",
  "-luuid",
];
await sh([
  join(llvmMingw, "bin", "x86_64-w64-mingw32-clang++"),
  ...common,
  "-o",
  join(pack, "x64", "vot_local.dll"),
]);
// 32-bit stdcall exports are decorated (_AIMPPluginGetHeader@4) unless --kill-at strips them.
await sh([
  join(llvmMingw, "bin", "i686-w64-mingw32-clang++"),
  ...common,
  "-Wl,--kill-at",
  "-o",
  join(pack, "vot_local.dll"),
]);
await copyFile(
  join(root, "plugins", "aimp", "README-RU.txt"),
  join(pack, "README.txt"),
);

const aimppack = join(out, "vot_local.aimppack");
await sh(["zip", "-q", "-r", aimppack, "vot_local"], join(out, "pack"));
console.log(aimppack);
