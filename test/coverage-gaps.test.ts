/**
 * Targeted regression tests for genuinely-uncovered REAL branches that the rest
 * of the suite doesn't reach directly. Each test names the exact src line it
 * drives. No istanbul-ignore, no faked state — every branch is exercised through
 * real behavior.
 *
 * Covered here:
 *   queue.ts:257-259  — the READ_TAIL_MAX_BYTES tail-read cap on a huge file
 *   queue.ts:200      — flushNow() forceDrain retry (immediate write on shutdown)
 *   queue.ts:201      — flushNow() debounced retry (data arrives mid-write)
 *   index.ts:213      — flush() facade swallows a throwing core.flush(), still resolves
 *   index.ts:242      — shutdown() facade swallows a throwing core.shutdown(), still resolves
 *   errors.ts:73-74   — uninstallErrorHooks() resets state even if removeListener throws
 *   errors.ts (path)  — captureErrors:true then shutdown() removes SDK listeners (baseline)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MuonCore } from '../src/core.js';
import { installErrorHooks, uninstallErrorHooks } from '../src/errors.js';
import { QueueStore } from '../src/queue.js';
import Muon, { flush, init, shutdown } from '../src/index.js';
import { coreConfig, removeDir, tempDir } from './helpers/env.js';

let dir: string;

beforeEach(async () => {
  dir = await tempDir();
});

afterEach(async () => {
  await shutdown(); // reset facade singleton between tests
  uninstallErrorHooks();
  vi.restoreAllMocks();
  await removeDir(dir);
});

// ---------------------------------------------------------------------------
// queue.ts:257-259 — a queue file LARGER than READ_TAIL_MAX_BYTES (32 MiB) is
// only tail-read: `start = size - READ_TAIL_MAX_BYTES; droppedPartialHead = true`.
// Only the newest tail loads, the (likely partial) first line is dropped, no
// throw, and the count is bounded.
// ---------------------------------------------------------------------------
describe('queue tail-read cap (queue.ts:257-259)', () => {
  const READ_TAIL_MAX_BYTES = 32 * 1024 * 1024;

  async function writeHugeQueue(file: string): Promise<{ total: number; lineBytes: number }> {
    await mkdir(dir, { recursive: true });
    const PAD = 'x'.repeat(60_000);
    const total = 600; // 600 * ~60 KiB ≈ 36 MiB > 32 MiB tail cap
    const parts: string[] = new Array(total);
    for (let i = 0; i < total; i++) {
      parts[i] = JSON.stringify({ project: 'proj-1', type: 'custom', name: `e-${i}`, pad: PAD });
    }
    const data = parts.join('\n') + '\n';
    expect(data.length).toBeGreaterThan(READ_TAIL_MAX_BYTES); // precondition: file exceeds the cap
    await writeFile(file, data, 'utf8');
    return { total, lineBytes: parts[0]!.length + 1 };
  }

  it('QueueStore.load() reads only the newest tail and drops the partial head', async () => {
    const store = new QueueStore(dir, 'proj-1');
    const { total, lineBytes } = await writeHugeQueue(store.queueFile);

    const loaded = await store.load(); // exercises readEvents → 257-259

    // Tail-trim ran: fewer than the full backlog loaded (the head was cut off).
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded.length).toBeLessThan(total);
    // Newest records survive; the oldest were beyond the 32 MiB tail window.
    expect(loaded[loaded.length - 1]!.name).toBe(`e-${total - 1}`);
    expect(loaded.some((e) => e.name === 'e-0')).toBe(false);
    // Bounded to roughly the tail-worth of records (with the partial head dropped).
    const tailCapacity = Math.floor(READ_TAIL_MAX_BYTES / lineBytes);
    expect(loaded.length).toBeLessThanOrEqual(tailCapacity);
    expect(loaded.length).toBeGreaterThanOrEqual(tailCapacity - 5);
    // The surviving names form a contiguous newest-suffix (droppedPartialHead + tail).
    const firstName = loaded[0]!.name!;
    const firstIdx = Number(firstName.slice(2));
    expect(loaded.map((e) => e.name)).toEqual(
      Array.from({ length: total - firstIdx }, (_, k) => `e-${firstIdx + k}`),
    );
  });

  it('a MuonCore restart over the huge file restores a bounded, non-zero buffer', async () => {
    const store = new QueueStore(dir, 'proj-1');
    const { total } = await writeHugeQueue(store.queueFile);

    // No real server needed: we only restore + inspect the buffer, never flush.
    const core = new MuonCore(coreConfig(dir, 'http://127.0.0.1:1/api/track/batch'));
    try {
      await core.settled();
      const n = core.bufferedCount();
      expect(n).toBeGreaterThan(0); // never collapses to empty
      expect(n).toBeLessThan(total); // tail-trimmed, bounded
      expect(n).toBeLessThanOrEqual(10_000); // never exceeds the default cap
    } finally {
      await core.shutdown();
    }
  });
});

// ---------------------------------------------------------------------------
// queue.ts:200-201 — the write-coalescing retry branches inside flushNow's
// finally. writeSnapshot is stubbed to a controllable deferred so we can freeze
// a write "in flight" and drive each branch deterministically. flushNow itself
// (the code under test) is the REAL method.
// ---------------------------------------------------------------------------
describe('write-coalescing retry branches (queue.ts:200-201)', () => {
  function deferredStore(): { store: QueueStore; pending: Array<() => void> } {
    const store = new QueueStore(dir, 'coalesce', undefined, 10_000, 5);
    const pending: Array<() => void> = [];
    vi.spyOn(store as unknown as { writeSnapshot: () => Promise<void> }, 'writeSnapshot').mockImplementation(
      () => new Promise<void>((resolve) => pending.push(resolve)),
    );
    return { store, pending };
  }
  const ev = (name: string) => [{ project: 'p', type: 'custom', name }];
  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('line 200: forceDrain (settle/shutdown) re-writes immediately when data arrived mid-write', async () => {
    const { store, pending } = deferredStore();
    const s = store as unknown as { writing: boolean; latest: unknown; timer: unknown; forceDrain: boolean };

    void store.persist(ev('1')); // schedules a debounced write
    const settled = store.settle(); // forceDrain=true → flushNow starts W1 immediately, clears the timer
    expect(s.writing).toBe(true);
    expect(s.forceDrain).toBe(true);
    expect(s.timer).toBeNull();

    void store.persist(ev('2')); // new data lands while W1 is in flight
    expect(s.latest).not.toBeNull();

    pending.shift()!(); // finish W1 → finally: latest!=null && forceDrain → flushNow() (line 200)
    await flushMicrotasks();
    // The forceDrain branch wrote W2 IMMEDIATELY (no debounce timer scheduled).
    expect(s.writing).toBe(true);
    expect(s.timer).toBeNull();

    pending.shift()!(); // finish W2
    await settled; // drain resolves, never rejects
    expect(s.writing).toBe(false);
    expect(s.latest).toBeNull();
  });

  it('line 201: a normal (non-force) write reschedules a debounced write when data arrives mid-write', async () => {
    const { store, pending } = deferredStore();
    const s = store as unknown as { writing: boolean; latest: unknown; timer: unknown; forceDrain: boolean };

    void store.persist(ev('1')); // schedules a debounced write (5ms)
    await new Promise((r) => setTimeout(r, 20)); // debounce fires → W1 in flight, forceDrain stays false
    expect(s.writing).toBe(true);
    expect(s.forceDrain).toBe(false);

    void store.persist(ev('2')); // new data lands while W1 is in flight

    pending.shift()!(); // finish W1 → finally: latest!=null && !forceDrain → scheduleWrite() (line 201)
    await flushMicrotasks();
    // The else branch scheduled a DEBOUNCE timer instead of writing immediately.
    expect(s.writing).toBe(false);
    expect(s.timer).not.toBeNull();

    // Let the rescheduled debounce fire and drain fully; nothing is lost.
    await new Promise((r) => setTimeout(r, 20));
    while (pending.length) {
      pending.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    await store.settle();
    expect(s.latest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// index.ts:213 / :242 — the facade's outermost catch guards. A public call must
// NEVER throw and its promise must NEVER reject, EVEN IF the underlying core
// method throws synchronously. (The pre-init no-op paths take earlier returns;
// these catch blocks fire only when the wrapped call itself throws.)
// ---------------------------------------------------------------------------
describe('facade never throws when the core throws (index.ts:213, :242)', () => {
  it('flush(): a synchronously-throwing core.flush() is swallowed and flush() still resolves (line 213)', async () => {
    init('proj-1', 'https://muon.run', { queueDir: dir });
    const spy = vi.spyOn(MuonCore.prototype, 'flush').mockImplementation(() => {
      throw new Error('boom from core.flush');
    });
    await expect(flush()).resolves.toBeUndefined(); // catch → Promise.resolve() (line 213)
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('shutdown(): a synchronously-throwing core.shutdown() is swallowed and shutdown() still resolves (line 242)', async () => {
    init('proj-1', 'https://muon.run', { queueDir: dir });
    const orig = MuonCore.prototype.shutdown;
    const spy = vi.spyOn(MuonCore.prototype, 'shutdown').mockImplementation(function (this: MuonCore) {
      void orig.call(this); // still release the core's real resources (timer, beforeExit hook)…
      throw new Error('boom from core.shutdown'); // …then throw to drive the facade catch
    });
    await expect(shutdown()).resolves.toBeUndefined(); // catch → Promise.resolve() (line 242)
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// errors.ts:73-74 — uninstallErrorHooks() must reset `current` and never throw
// even if process.removeListener throws mid-uninstall. Plus the documented
// captureErrors → shutdown path returns the process listener counts to baseline.
// ---------------------------------------------------------------------------
describe('error-hook uninstall (errors.ts:73-74)', () => {
  it('uninstall resets state and never throws even if removeListener throws (lines 73-74)', () => {
    const core = new MuonCore(coreConfig(dir, 'http://127.0.0.1:1/api/track/batch'));
    try {
      installErrorHooks(core);
      const spy = vi.spyOn(process, 'removeListener').mockImplementation(() => {
        throw new Error('removeListener exploded');
      });
      // The try in uninstallErrorHooks throws inside current.uninstall() → catch (73) sets current=null (74).
      expect(() => uninstallErrorHooks()).not.toThrow();
      spy.mockRestore();
      // `current` was reset: a follow-up install/uninstall cycle works cleanly from baseline.
      const monitorBase = process.listenerCount('uncaughtExceptionMonitor');
      const rejBase = process.listenerCount('unhandledRejection');
      installErrorHooks(core);
      expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(monitorBase + 1);
      uninstallErrorHooks();
      expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(monitorBase);
      expect(process.listenerCount('unhandledRejection')).toBe(rejBase);
    } finally {
      // If the throwing-uninstall left our first listeners attached, drop them now.
      uninstallErrorHooks();
    }
  });

  it('init(captureErrors:true) then shutdown() returns the process listeners to baseline', async () => {
    const monitorBefore = process.listenerCount('uncaughtExceptionMonitor');
    const rejBefore = process.listenerCount('unhandledRejection');
    init('proj-1', 'https://muon.run', { queueDir: dir, captureErrors: true });
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(monitorBefore + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(rejBefore + 1);
    await shutdown(); // calls uninstallErrorHooks() → removes exactly the SDK listeners
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(monitorBefore);
    expect(process.listenerCount('unhandledRejection')).toBe(rejBefore);
  });

  it('exposes the same default-export API (sanity)', () => {
    expect(Muon.flush).toBe(flush);
    expect(Muon.shutdown).toBe(shutdown);
  });
});
