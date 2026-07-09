/**
 * Regression tests for the two-lens audit findings. One test per finding, with
 * numeric assertions that fail loudly if the durability/freeze/resource fix
 * regresses. See `node-sdk-findings.md`.
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clampInt } from '../src/clamp.js';
import { MuonCore } from '../src/core.js';
import { sanitizeProperties } from '../src/event.js';
import { QueueStore } from '../src/queue.js';
import { coreConfig, removeDir, tempDir } from './helpers/env.js';
import { refusedPort, startServer, type FixtureServer } from './helpers/server.js';

const execFileAsync = promisify(execFile);
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let dir: string;
let server: FixtureServer;
const cores: MuonCore[] = [];

function makeCore(overrides = {}): MuonCore {
  const core = new MuonCore(coreConfig(dir, `${server.url}/api/track/batch`, overrides));
  cores.push(core);
  return core;
}

beforeEach(async () => {
  dir = await tempDir();
  server = await startServer();
});

afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.shutdown()));
  await server.close();
  await removeDir(dir);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// CRITICAL B1 — write coalescing: a synchronous burst of N track() ⇒ ~1 disk
// write via an unref'd debounce, NOT O(N); the event loop never freezes.
// ---------------------------------------------------------------------------
describe('B1 write coalescing (CRITICAL)', () => {
  it('100k synchronous track() collapse into a tiny constant number of disk writes, and the write never blocks the loop', async () => {
    const writeSpy = vi.spyOn(QueueStore.prototype as unknown as { writeSnapshot: () => Promise<void> }, 'writeSnapshot');
    const core = makeCore({ flushAt: 5_000_000, maxQueueEvents: 10_000 });

    const N = 100_000;
    for (let i = 0; i < N; i++) core.track('burst', { i });
    // NB: the synchronous 100k-call loop above is the CALLER's own CPU cost
    // (~17µs/call of sanitization) and inherently occupies the loop regardless
    // of persistence strategy — so we measure SDK-induced lag AFTER the burst,
    // across the async drain window, where the coalesced write actually runs.
    // The old bug spun 109% CPU for >150s here; coalesced, the drain is quiet.

    let maxLag = 0;
    let last = performance.now();
    const sampler = setInterval(() => {
      const now = performance.now();
      const lag = now - last - 10;
      if (lag > maxLag) maxLag = lag;
      last = now;
    }, 10);
    await new Promise((r) => setTimeout(r, 500)); // debounced write lands inside this window
    clearInterval(sampler);
    await core.settled();

    const writes = writeSpy.mock.calls.length;
    // The old bug did ~0.6·N writes (3000 track → 1876). Coalesced, a single
    // synchronous burst is ONE debounced write (allow a tiny trailing margin).
    expect(writes).toBeGreaterThanOrEqual(1);
    expect(writes).toBeLessThanOrEqual(3);
    expect(maxLag).toBeLessThan(50); // serializing one 10k snapshot never freezes the loop
    expect(core.bufferedCount()).toBe(10_000); // buffer stays capped
  });

  it('the debounce timer is unref()ed so a pending write can never keep the process alive', () => {
    const store = new QueueStore(dir, 'unref-check');
    void store.persist([{ project: 'p', type: 'custom', name: 'x' }]);
    const timer = (store as unknown as { timer: NodeJS.Timeout | null }).timer;
    expect(timer).not.toBeNull();
    expect(timer!.hasRef()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL B1 (process-exit) — a no-shutdown child with a large burst must exit
// on its own quickly; the write storm cannot linger the exit.
// ---------------------------------------------------------------------------
describe('B1 process-exit under a large burst (CRITICAL)', () => {
  it('a child that tracks 50k events WITHOUT shutdown() exits within 3s', async () => {
    const port = await refusedPort(); // network flush fails fast; only the disk path matters
    const t0 = Date.now();
    const { stdout } = await execFileAsync(process.execPath, [fixture('exit-large-burst.mjs'), String(port), dir, '50000'], {
      timeout: 3_000, // a hard kill here = the exit lingered = failed test
    });
    const elapsed = Date.now() - t0;
    expect(stdout).toContain('TRACKED 50000');
    expect(elapsed).toBeLessThan(3_000);
  });
});

// ---------------------------------------------------------------------------
// HIGH B2 — single-flight auto-flush + retryAt honored inside doFlush: a sync
// burst against an always-503 server must NOT become a back-to-back retry storm.
// ---------------------------------------------------------------------------
describe('B2 backoff under a sync burst (HIGH)', () => {
  it('1000 synchronous track() vs an always-503 server ⇒ a tiny, spaced POST count (not ~1000)', async () => {
    server.setMode(503);
    const core = makeCore({ flushAt: 20, maxQueueEvents: 10_000 });

    for (let i = 0; i < 1000; i++) core.track('storm', { i });

    // Give the single queued auto-flush time to run (and prove no others pile on).
    await new Promise((r) => setTimeout(r, 500));

    const posts = server.requests();
    // Old bug: ~981 POSTs within 500ms. Single-flight + backoff ⇒ at most a
    // couple within one backoff window.
    expect(posts).toBeGreaterThanOrEqual(1);
    expect(posts).toBeLessThanOrEqual(3);
    expect(core.bufferedCount()).toBe(1000); // everything re-queued, nothing lost
  });

  it('doFlush honors retryAt on the auto path: a second auto-flush inside the backoff window sends nothing new', async () => {
    server.setMode(503);
    const core = makeCore({ flushAt: 1, maxQueueEvents: 10_000 });
    core.track('a'); // triggers the first (and only allowed) auto-flush → 503 → sets retryAt
    await new Promise((r) => setTimeout(r, 50));
    const after = server.requests();
    expect(after).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 50; i++) core.track(`b-${i}`); // still inside backoff
    await new Promise((r) => setTimeout(r, 150));
    expect(server.requests()).toBe(after); // NOT hammered
    expect(core.bufferedCount()).toBe(51);
  });
});

// ---------------------------------------------------------------------------
// MEDIUM A1/B4 — a persisted backlog larger than the JS argument-spread limit
// (~125k) must restore to min(persisted, cap), NEVER collapse to 0.
// ---------------------------------------------------------------------------
describe('A1/B4 large persisted queue restore (MEDIUM)', () => {
  it('a 200k-line backlog restores fully (no RangeError → empty queue)', async () => {
    await mkdir(dir, { recursive: true });
    const N = 200_000; // safely above the ~125k spread/apply limit
    const parts: string[] = new Array(N);
    for (let i = 0; i < N; i++) parts[i] = JSON.stringify({ project: 'proj-1', type: 'custom', name: `q-${i}` });
    await writeFile(join(dir, 'proj-1.queue.jsonl'), parts.join('\n') + '\n');

    const core = makeCore({ maxQueueEvents: 250_000, flushAt: 10_000_000 });
    await core.settled();
    expect(core.bufferedCount()).toBe(200_000); // whole valid backlog kept, NOT 0
  });

  it('a backlog larger than the cap restores to exactly the cap (newest kept), still never 0', async () => {
    await mkdir(dir, { recursive: true });
    const N = 200_000;
    const parts: string[] = new Array(N);
    for (let i = 0; i < N; i++) parts[i] = JSON.stringify({ project: 'proj-1', type: 'custom', name: `q-${i}` });
    await writeFile(join(dir, 'proj-1.queue.jsonl'), parts.join('\n') + '\n');

    const cap = 150_000;
    const core = makeCore({ maxQueueEvents: cap, flushAt: 10_000_000 });
    await core.settled();
    expect(core.bufferedCount()).toBe(cap); // trimmed to cap before build, drop-oldest
  });
});

// ---------------------------------------------------------------------------
// LOW/MEDIUM A2 — maxQueueEvents has a real upper bound so a hostile option
// can't drive the buffer/file to OOM.
// ---------------------------------------------------------------------------
describe('A2 maxQueueEvents upper bound (LOW/MEDIUM)', () => {
  it('clampInt applies both bounds; a huge maxQueueEvents is capped at 1_000_000', () => {
    // The init() call site: clampInt(opts.maxQueueEvents, 10_000, 1, 1_000_000).
    expect(clampInt(10_000_000, 10_000, 1, 1_000_000)).toBe(1_000_000);
    expect(clampInt(Number.MAX_SAFE_INTEGER, 10_000, 1, 1_000_000)).toBe(1_000_000);
    expect(clampInt(Number.POSITIVE_INFINITY, 10_000, 1, 1_000_000)).toBe(10_000); // non-finite → fallback
    expect(clampInt(NaN, 10_000, 1, 1_000_000)).toBe(10_000);
    expect(clampInt(-5, 10_000, 1, 1_000_000)).toBe(1); // lower bound
    expect(clampInt(50_000, 10_000, 1, 1_000_000)).toBe(50_000); // in range, passes through
    expect(clampInt('nope' as unknown, 10_000, 1, 1_000_000)).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// LOW/MODERATE B4b — the crash file is capped so a crash-loop can't grow it
// without bound.
// ---------------------------------------------------------------------------
describe('B4b crash file cap (LOW/MODERATE)', () => {
  it('repeated appendCrashSync keeps the crash file bounded (drop-oldest)', async () => {
    const store = new QueueStore(dir, 'crashcap');
    // Append far more than the cap; each record is padded so bytes accumulate fast.
    for (let i = 0; i < 3_000; i++) {
      store.appendCrashSync({ project: 'p', type: 'browser_error', name: 'E', message: `crash-${i} ${'x'.repeat(200)}` });
    }
    const loaded = await store.loadCrashes();
    // CRASH_MAX_EVENTS = 500: never more than the cap is retained…
    expect(loaded.length).toBeLessThanOrEqual(500);
    expect(loaded.length).toBeGreaterThan(0);
    // …and the survivors are the NEWEST records (drop-oldest).
    const last = loaded[loaded.length - 1]!;
    expect(last.message).toContain('crash-2999');
  });
});

// ---------------------------------------------------------------------------
// LOW B3 — shutdown() awaits the pending persist and releases every resource:
// no SDK-owned handle survives shutdown() resolving.
// ---------------------------------------------------------------------------
describe('B3 no resources survive shutdown (LOW)', () => {
  it('a full track→shutdown cycle leaves zero SDK-owned active resources', async () => {
    const getInfo = (process as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo;
    if (!getInfo) return; // Node < 17.3 — covered by the _getActiveHandles test in lifecycle.test.ts
    const timersBefore = getInfo.call(process).filter((r) => r === 'Timeout' || r === 'Immediate').length;

    const core = makeCore({ flushAt: 5 });
    for (let i = 0; i < 12; i++) core.track('res', { i });
    await core.shutdown();
    await new Promise((r) => setTimeout(r, 30));

    // No leftover FS request / socket / trailing write is in flight, and the
    // flush + debounce timers were cleared: SDK-owned timers back to baseline.
    const timersAfter = getInfo.call(process).filter((r) => r === 'Timeout' || r === 'Immediate').length;
    expect(timersAfter).toBeLessThanOrEqual(timersBefore);
    // The store settled: nothing pending to write.
    const store = (core as unknown as { store: QueueStore }).store;
    const writing = (store as unknown as { writing: boolean }).writing;
    const latest = (store as unknown as { latest: unknown }).latest;
    expect(writing).toBe(false);
    expect(latest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LOW A3 — one hostile nested value drops only ITSELF; sibling keys survive.
// ---------------------------------------------------------------------------
describe('A3 per-value sanitize isolation (LOW)', () => {
  it('a Proxy whose traps throw drops only that value; {good:1} is retained', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap: get');
        },
        getPrototypeOf() {
          throw new Error('trap: getPrototypeOf');
        },
        ownKeys() {
          throw new Error('trap: ownKeys');
        },
        has() {
          throw new Error('trap: has');
        },
      },
    );
    const out = sanitizeProperties({ good: 1, bad: hostile });
    expect(out).toEqual({ good: 1 }); // sibling survived; whole payload NOT dropped
  });

  it('a throwing-trap value nested among several siblings loses only itself', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('boom');
        },
        get() {
          throw new Error('boom');
        },
      },
    );
    const out = sanitizeProperties({ a: 1, bad: hostile, b: 'two', c: [1, 2] });
    expect(out).toEqual({ a: 1, b: 'two', c: [1, 2] });
  });

  // event.ts:179 — the ARRAY-element `continue`. Distinct from the object-getter
  // branch above: here indexing the array itself throws (a Proxy-over-array whose
  // `get` trap throws for one index). Only that element is skipped; the sibling
  // element AND the sibling key survive.
  it('an array whose element access throws skips only that element (line 179)', () => {
    const hostile = new Proxy([0, 0], {
      get(target, prop, recv) {
        if (prop === 'length') return 2; // let the loop run
        if (prop === '0') throw new Error('trap: index 0 read'); // indexing throws → line 179 `continue`
        if (prop === '1') return 42; // the sibling element survives
        return Reflect.get(target, prop, recv);
      },
    });
    // Array.isArray sees through the Proxy to the array target, so sanitizeValue
    // takes the array branch and hits the `raw = obj[i]` try/catch at 177-180.
    expect(Array.isArray(hostile)).toBe(true);
    const out = sanitizeProperties({ good: 1, hostile });
    // index 0 dropped via line 179; index 1 (42) kept; sibling key `good` intact.
    expect(out).toEqual({ good: 1, hostile: [42] });
  });
});
