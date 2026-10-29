import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { onCleanup } from "./cleanup";

export type ToolName = "ffmpeg" | "ffprobe" | "cloudflared";

export class ProcessError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export function findTool(
  name: ToolName,
  exeDir: string = dirname(process.execPath),
  which: (cmd: string) => string | null = Bun.which,
): string {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  const local = join(exeDir, file);
  if (existsSync(local)) {
    return local;
  }

  const found = which(name);
  if (found) {
    return found;
  }

  throw new Error(
    `Не найден ${file}: он должен лежать в одной папке с vot-local`,
  );
}

export async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const forget = onCleanup(() => proc.kill());
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      const tail = stderr.trim().split("\n").slice(-5).join("\n");
      throw new ProcessError(
        `${basename(cmd[0] ?? "")} завершился с кодом ${code}: ${tail}`,
        stderr,
      );
    }

    return stdout;
  } finally {
    forget();
  }
}
