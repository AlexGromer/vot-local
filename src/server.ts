import { randomBytes } from "node:crypto";

export type ByteRange = { start: number; end: number };

export type AudioServer = {
  localUrl: string;
  path: string;
  stop: () => void;
};

export function parseRange(
  header: string | null,
  size: number,
): ByteRange | "unsatisfiable" | null {
  // Malformed and multi-range headers are ignored (full response), as RFC 9110 allows.
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) {
    return null;
  }

  const [, from = "", to = ""] = match;
  if (from && to && Number(from) > Number(to)) {
    return null;
  }

  const start = from ? Number(from) : Math.max(0, size - Number(to));
  const end = from && to ? Math.min(Number(to), size - 1) : size - 1;
  return start >= size || (!from && Number(to) === 0)
    ? "unsatisfiable"
    : { start, end };
}

export function serveFile(
  file: string,
  token: string = randomBytes(16).toString("hex"),
): AudioServer {
  const path = `/${token}/audio.mp4`;
  const audio = Bun.file(file);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 120,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== path || !["GET", "HEAD"].includes(req.method)) {
        return new Response("Not found", { status: 404 });
      }

      const size = audio.size;
      const headers: Record<string, string> = {
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
      };
      const range = parseRange(req.headers.get("range"), size);
      if (range === "unsatisfiable") {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${size}` },
        });
      }

      const body = (start: number, end: number) =>
        req.method === "HEAD" ? null : audio.slice(start, end + 1);
      if (range) {
        return new Response(body(range.start, range.end), {
          status: 206,
          headers: {
            ...headers,
            "content-range": `bytes ${range.start}-${range.end}/${size}`,
            "content-length": String(range.end - range.start + 1),
          },
        });
      }

      return new Response(body(0, size - 1), {
        headers: { ...headers, "content-length": String(size) },
      });
    },
  });

  return {
    localUrl: `http://127.0.0.1:${server.port}`,
    path,
    stop: () => server.stop(true),
  };
}
