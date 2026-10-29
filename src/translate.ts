import type { RequestLang, ResponseLang } from "@vot.js/shared/types/data";

const PART_CONTENT = 5;
const AUDIO_REQUESTED = 6;
const MIN_WAIT_MS = 10_000;
const MAX_WAIT_MS = 30_000;
const MAX_TRANSIENT_ERRORS = 3;

export type TranslationRequest = {
  url: string;
  duration: number;
  requestLang: RequestLang;
  responseLang: ResponseLang;
  livelyVoice: boolean;
};

export type TranslationResult = {
  translated: boolean;
  status?: number;
  remainingTime?: number;
  url?: string;
  message?: string;
};

export type TranslateFn = (
  req: TranslationRequest,
) => Promise<TranslationResult>;

export type WaitOptions = {
  timeoutMs?: number;
  onWait?: (remainingSeconds: number, message?: string) => void;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
};

export function waitDelay(remainingSeconds: number | undefined): number {
  const ms = (remainingSeconds ?? 0) * 1000;
  return Math.min(Math.max(ms, MIN_WAIT_MS), MAX_WAIT_MS);
}

export function isComplete(res: TranslationResult): boolean {
  if (!res.translated || !res.url) {
    return false;
  }

  // PART_CONTENT carries audio for the first part only; keep polling for the full track.
  return res.status !== PART_CONTENT || (res.remainingTime ?? 0) < 1;
}

function isBackendError(err: unknown): boolean {
  // vot.js reports a refused translation as VOTJSError; anything else is a network hiccup.
  return err instanceof Error && err.name === "VOTJSError";
}

export async function waitForTranslation(
  translate: TranslateFn,
  req: TranslationRequest,
  {
    timeoutMs = 3 * 60 * 60 * 1000,
    onWait,
    sleep = Bun.sleep,
    now = Date.now,
  }: WaitOptions = {},
): Promise<string> {
  const deadline = now() + timeoutMs;
  let transientErrors = 0;
  while (now() < deadline) {
    let res: TranslationResult;
    try {
      res = await translate(req);
      transientErrors = 0;
    } catch (err) {
      if (isBackendError(err) || ++transientErrors > MAX_TRANSIENT_ERRORS) {
        throw err;
      }
      await sleep(MAX_WAIT_MS);
      continue;
    }

    if (isComplete(res) && res.url) {
      return res.url;
    }
    if (res.status === AUDIO_REQUESTED) {
      throw new Error(
        "Сервер перевода не смог скачать звук этого файла через туннель",
      );
    }

    onWait?.(res.remainingTime ?? -1, res.message);
    await sleep(waitDelay(res.remainingTime));
  }

  throw new Error("Сервер перевода не закончил за 3 часа, попробуйте позже");
}
