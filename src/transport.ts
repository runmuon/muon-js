/**
 * Wire transport: gzip'd `POST {host}/api/track/batch` using the global
 * `fetch` (Node >= 18) — zero dependencies.
 *
 * Do-no-harm rules enforced here:
 * - `send` NEVER throws or rejects — every fault maps to an outcome the core
 *   can act on ('ok' | 'retry' | 'drop').
 * - Every request has a hard timeout enforced with `AbortController`; the
 *   abort timer is `unref()`ed so it can never keep the process alive.
 * - Permanent rejections (4xx other than 429) are 'drop', never retried.
 * - A batch that cannot be serialized or compressed is 'drop' (poison batch),
 *   never retried forever.
 * - gzip runs off the event loop (async zlib), not `gzipSync`.
 */

import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { MuonEvent } from './event.js';

const gzipAsync = promisify(gzip);

/** Max events per request, per the event contract. */
export const MAX_BATCH_SIZE = 1000;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_CAP_MS = 30_000;

/**
 * Capped exponential backoff with jitter. Pure so the cap is unit-testable:
 * delay ∈ [cap/2, cap] once the exponential curve reaches the cap.
 */
export function backoffDelay(failures: number, random: () => number = Math.random): number {
  const n = Math.min(Math.max(failures, 1), 16);
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
  return exp / 2 + random() * (exp / 2);
}

export type SendOutcome = 'ok' | 'retry' | 'drop';

export interface SendResult {
  outcome: SendOutcome;
  status?: number;
  /** Parsed from the `{ processed }` response body when present. */
  processed?: number;
}

export class Transport {
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
  ) {}

  /** POST one batch (<= MAX_BATCH_SIZE events). Never throws or rejects. */
  async send(events: MuonEvent[], timeoutMs: number = this.timeoutMs): Promise<SendResult> {
    let body: Buffer;
    try {
      const json = JSON.stringify({ events });
      body = await gzipAsync(Buffer.from(json, 'utf8'));
    } catch {
      return { outcome: 'drop' }; // poison batch — sanitization makes this ~unreachable
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    timer.unref?.();
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        },
        body: new Uint8Array(body),
        signal: controller.signal,
      });
      // Read the body best-effort; a malformed body must not decide anything —
      // the status code does.
      let processed: number | undefined;
      try {
        const parsed: unknown = await res.json();
        if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { processed?: unknown }).processed === 'number') {
          processed = (parsed as { processed: number }).processed;
        }
      } catch {
        // non-JSON / empty body — fine
      }
      if (res.ok) return { outcome: 'ok', status: res.status, processed };
      if (res.status === 429 || res.status >= 500) return { outcome: 'retry', status: res.status };
      return { outcome: 'drop', status: res.status }; // 400/401/403/…
    } catch {
      // refused connection, DNS failure, reset, timeout abort, …
      return { outcome: 'retry' };
    } finally {
      clearTimeout(timer);
    }
  }
}
