import { describe, expect, test } from "bun:test";
import {
  isComplete,
  type TranslationRequest,
  type TranslationResult,
  waitDelay,
  waitForTranslation,
} from "../src/translate";

const req: TranslationRequest = {
  url: "https://x.trycloudflare.com/t/audio.mp4",
  duration: 90,
  requestLang: "auto",
  responseLang: "ru",
  livelyVoice: false,
};

function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

function sequence(results: TranslationResult[]) {
  const calls: TranslationRequest[] = [];
  const translate = async (r: TranslationRequest) => {
    calls.push(r);
    const next = results.shift();
    if (!next) {
      throw new Error("no more results");
    }
    return next;
  };
  return { calls, translate };
}

describe("waitDelay", () => {
  test("clamps to 10..30 s", () => {
    expect(waitDelay(undefined)).toBe(10_000);
    expect(waitDelay(-1)).toBe(10_000);
    expect(waitDelay(15)).toBe(15_000);
    expect(waitDelay(130)).toBe(30_000);
  });
});

describe("isComplete", () => {
  test("finished with url", () => {
    expect(isComplete({ translated: true, status: 1, url: "u" })).toBe(true);
  });

  test("part content waits for the rest", () => {
    expect(
      isComplete({ translated: true, status: 5, url: "u", remainingTime: 60 }),
    ).toBe(false);
    expect(
      isComplete({ translated: true, status: 5, url: "u", remainingTime: 0 }),
    ).toBe(true);
  });

  test("not translated or no url", () => {
    expect(isComplete({ translated: false, status: 2 })).toBe(false);
    expect(isComplete({ translated: true, status: 1 })).toBe(false);
  });
});

describe("waitForTranslation", () => {
  test("waits through WAITING and PART_CONTENT until FINISHED", async () => {
    const clock = fakeClock();
    const waits: number[] = [];
    const { calls, translate } = sequence([
      { translated: false, status: 2, remainingTime: 130 },
      { translated: false, status: 3, remainingTime: 20 },
      { translated: true, status: 5, url: "part", remainingTime: 40 },
      { translated: true, status: 1, url: "full", remainingTime: -1 },
    ]);
    const url = await waitForTranslation(translate, req, {
      ...clock,
      onWait: (sec) => waits.push(sec),
    });
    expect(url).toBe("full");
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual(req);
    expect(clock.sleeps).toEqual([30_000, 20_000, 30_000]);
    expect(waits).toEqual([130, 20, 40]);
  });

  test("propagates backend errors", async () => {
    let calls = 0;
    const translate = async () => {
      calls++;
      const err = new Error("Yandex couldn't translate video");
      err.name = "VOTJSError";
      throw err;
    };
    await expect(
      waitForTranslation(translate, req, fakeClock()),
    ).rejects.toThrow("Yandex couldn't translate video");
    expect(calls).toBe(1);
  });

  test("retries a few network errors, then gives up", async () => {
    const flaky = sequence([
      { translated: false, status: 2, remainingTime: 30 },
      { translated: true, status: 1, url: "full" },
    ]);
    let failures = 2;
    const recovering = async (r: TranslationRequest) => {
      if (failures-- > 0) {
        throw new TypeError("fetch failed");
      }
      return flaky.translate(r);
    };
    expect(await waitForTranslation(recovering, req, fakeClock())).toBe("full");

    let calls = 0;
    const down = async () => {
      calls++;
      throw new TypeError("fetch failed");
    };
    await expect(waitForTranslation(down, req, fakeClock())).rejects.toThrow(
      "fetch failed",
    );
    expect(calls).toBe(4);
  });

  test("stops when the backend cannot fetch the audio", async () => {
    const { translate } = sequence([
      { translated: false, status: 6, remainingTime: 120 },
    ]);
    await expect(
      waitForTranslation(translate, req, fakeClock()),
    ).rejects.toThrow("не смог скачать звук");
  });

  test("passes the backend message to onWait", async () => {
    const seen: (string | undefined)[] = [];
    const { translate } = sequence([
      { translated: false, status: 2, message: "queued" },
      { translated: true, status: 1, url: "full" },
    ]);
    await waitForTranslation(translate, req, {
      ...fakeClock(),
      onWait: (_sec, message) => seen.push(message),
    });
    expect(seen).toEqual(["queued"]);
  });

  test("gives up after the timeout", async () => {
    const translate = async () => ({ translated: false, remainingTime: 10 });
    await expect(
      waitForTranslation(translate, req, { ...fakeClock(), timeoutMs: 25_000 }),
    ).rejects.toThrow("3 часа");
  });
});
