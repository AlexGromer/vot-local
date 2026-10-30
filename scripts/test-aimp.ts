import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// Runs the x64 plugin inside a fake AIMP host under Wine.
const root = join(import.meta.dir, "..");
const llvmMingw = process.env.LLVM_MINGW;
const plugin = join(
  root,
  "dist",
  "aimp",
  "pack",
  "vot_local",
  "x64",
  "vot_local.dll",
);
const headers = join(root, "vendor", "aimp-sdk", "Sources", "Cpp");
const bin = join(root, "dist", "aimp", "test");

if (!llvmMingw || !existsSync(plugin) || !existsSync(headers)) {
  throw new Error("run scripts/build-aimp.ts first and set LLVM_MINGW");
}

function wine(path: string): string {
  return `Z:${path.replaceAll("/", "\\")}`;
}

async function sh(cmd: string[], quiet = false): Promise<number> {
  const proc = Bun.spawn(cmd, {
    cwd: root,
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
    env: { ...process.env, WINEDEBUG: "-all" },
  });
  return proc.exited;
}

await mkdir(bin, { recursive: true });
const cxx = join(llvmMingw, "bin", "x86_64-w64-mingw32-clang++");
const flags = ["-std=c++17", "-O1", "-municode", "-static"];
for (const [src, exe] of [
  ["host.cpp", "host.exe"],
  ["fake_vot_local.cpp", "vot-local.exe"],
] as const) {
  const code = await sh([
    cxx,
    ...flags,
    "-isystem",
    headers,
    join(root, "plugins", "aimp", "test", src),
    "-o",
    join(bin, exe),
    "-luuid",
  ]);
  if (code !== 0) {
    throw new Error(`build of ${src} failed`);
  }
}

const key = "HKCU\\Software\\vot-local";
await sh(
  ["wine", "reg", "add", key, "/v", "InstallPath", "/d", wine(bin), "/f"],
  true,
);
const runs = await Promise.all(
  ["normal", "finalize"].map(async (mode) => {
    const work = join(bin, `work-${mode}`);
    await mkdir(work, { recursive: true });
    return sh(["wine", join(bin, "host.exe"), wine(plugin), wine(work), mode]);
  }),
);
await sh(["wine", "reg", "delete", key, "/f"], true);
if (runs.some((code) => code !== 0)) {
  throw new Error(`plugin test failed (exit codes ${runs.join(", ")})`);
}
