type Task = () => void;

const tasks = new Set<Task>();

export function onCleanup(task: Task): () => void {
  tasks.add(task);
  return () => {
    tasks.delete(task);
  };
}

export function runCleanup(): void {
  for (const task of [...tasks].reverse()) {
    try {
      task();
    } catch {}
  }
  tasks.clear();
}

export function cleanupOnSignals(): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      runCleanup();
      process.exit(130);
    });
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
