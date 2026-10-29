import { onCleanup } from "./cleanup";

const TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;
const REGISTERED = /Registered tunnel connection/;

export type Tunnel = {
  url: string;
  stop: () => void;
};

export function findTunnelUrl(log: string): string | undefined {
  return log.match(TUNNEL_URL)?.[0];
}

export function readyTunnelUrl(log: string): string | undefined {
  // The hostname is printed before the edge connection exists; resolving it that early
  // gets a negative answer cached by resolvers for minutes.
  return REGISTERED.test(log) ? findTunnelUrl(log) : undefined;
}

export function tunnelError(log: string, timedOut: boolean): string {
  if (/429|Too Many Requests|rate limit/i.test(log)) {
    return "Cloudflare временно ограничил создание туннелей, попробуйте через несколько минут";
  }

  const hint = "проверьте интернет; VPN, прокси или антивирус могут мешать";
  const tail = log.trim().split("\n").slice(-2).join("\n");
  return timedOut
    ? `Туннель не открылся за 90 с: ${hint}`
    : `Не удалось открыть туннель: ${hint}\n${tail}`;
}

export async function openTunnel(
  cloudflared: string,
  localUrl: string,
  timeoutMs = 90_000,
): Promise<Tunnel> {
  const proc = Bun.spawn(
    [
      cloudflared,
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      "http2",
      "--url",
      localUrl,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const forget = onCleanup(() => proc.kill());
  const stop = () => {
    proc.kill();
    forget();
  };
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  let log = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      log += decoder.decode(value, { stream: true });
      const url = readyTunnelUrl(log);
      if (url) {
        // cloudflared exits if nobody drains its log pipe.
        void drain(reader);
        return { url, stop };
      }
    }
  } catch {
  } finally {
    clearTimeout(timer);
  }

  stop();
  throw new Error(tunnelError(log, timedOut));
}

async function drain(reader: { read(): Promise<{ done: boolean }> }) {
  try {
    while (!(await reader.read()).done) {}
  } catch {}
}

export async function waitReachable(
  url: string,
  timeoutMs = 60_000,
  fetchFn: typeof fetch = fetch,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await sleep(3_000);
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        return;
      }
    } catch {}
    await sleep(5_000);
  }

  throw new Error(
    "Туннель открылся, но не отвечает: проверьте интернет и повторите",
  );
}
