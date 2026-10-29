import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AudioServer, parseRange, serveFile } from "../src/server";

describe("parseRange", () => {
  test("no header", () => {
    expect(parseRange(null, 100)).toBeNull();
  });

  test("open and closed ranges", () => {
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
  });

  test("malformed and multi-range headers are ignored", () => {
    expect(parseRange("bytes=-", 100)).toBeNull();
    expect(parseRange("bytes=20-10", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
  });

  test("unsatisfiable ranges", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
  });
});

describe("serveFile", () => {
  let dir: string;
  let server: AudioServer;
  const data = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "vot-local-test-"));
    const file = join(dir, "audio.mp4");
    await writeFile(file, data);
    server = serveFile(file, "token123");
  });

  afterAll(async () => {
    server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("serves the whole file under the token path", async () => {
    const res = await fetch(`${server.localUrl}${server.path}`);
    expect(server.path).toBe("/token123/audio.mp4");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
  });

  test("serves byte ranges", async () => {
    const res = await fetch(`${server.localUrl}${server.path}`, {
      headers: { range: "bytes=10-19" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/256");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data.slice(10, 20));
  });

  test("HEAD has no body", async () => {
    const res = await fetch(`${server.localUrl}${server.path}`, {
      method: "HEAD",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("256");
  });

  test("rejects other paths, methods and bad ranges", async () => {
    expect((await fetch(`${server.localUrl}/audio.mp4`)).status).toBe(404);
    expect((await fetch(`${server.localUrl}/other/audio.mp4`)).status).toBe(
      404,
    );
    const post = await fetch(`${server.localUrl}${server.path}`, {
      method: "POST",
    });
    expect(post.status).toBe(404);
    const bad = await fetch(`${server.localUrl}${server.path}`, {
      headers: { range: "bytes=999-" },
    });
    expect(bad.status).toBe(416);
  });

  test("random token by default", () => {
    const a = serveFile(join(dir, "audio.mp4"));
    const b = serveFile(join(dir, "audio.mp4"));
    a.stop();
    b.stop();
    expect(a.path).toMatch(/^\/[0-9a-f]{32}\/audio\.mp4$/);
    expect(a.path).not.toBe(b.path);
  });
});
