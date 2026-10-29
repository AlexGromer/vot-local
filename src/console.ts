import { dlopen, FFIType } from "bun:ffi";

const CP_UTF8 = 65001;

export function useUtf8Console(): void {
  if (process.platform !== "win32") {
    return;
  }

  try {
    const kernel32 = dlopen("kernel32.dll", {
      SetConsoleOutputCP: { args: [FFIType.u32], returns: FFIType.i32 },
    });
    kernel32.symbols.SetConsoleOutputCP(CP_UTF8);
    kernel32.close();
  } catch {}
}
