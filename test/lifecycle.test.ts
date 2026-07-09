/** Contract rows: Lifecycle & freeze-prevention. */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MuonCore } from '../src/core.js';
import { flush, init, shutdown, track } from '../src/index.js';
import { coreConfig, removeDir, tempDir } from './helpers/env.js';
import { refusedPort, startServer, type FixtureServer } from './helpers/server.js';

const execFileAsync = promisify(execFile);
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let dir: string;
let server: FixtureServer;
const cores: MuonCore[] = [];

beforeEach(async () => {
  dir = await tempDir();
  server = await startServer();
});

afterEach(async () => {
  await shutdown();
  await Promise.all(cores.splice(0).map((c) => c.shutdown()));
  await server.close();
  await removeDir(dir);
});

describe('process-exit behavior (the killer tests)', () => {
  it('a child that init()s + track()s WITHOUT shutdown() exits by itself within 3s — and the bounded beforeExit flush delivered', async () => {
    const t0 = Date.now();
    const { stdout } = await execFileAsync(process.execPath, [fixture('exit-no-shutdown.mjs'), String(server.port), dir], {
      timeout: 3_000, // hard kill = failed test
    });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(stdout).toContain('TRACKED');
    expect(server.allEvents().map((e) => e.name)).toEqual(['exit-0', 'exit-1', 'exit-2', 'exit-3', 'exit-4']);
  });

  it('with an unreachable server the child STILL exits within 3s and events are persisted, not lost', async () => {
    const port = await refusedPort();
    const t0 = Date.now();
    await execFileAsync(process.execPath, [fixture('exit-no-shutdown.mjs'), String(port), dir], { timeout: 3_000 });
    expect(Date.now() - t0).toBeLessThan(3_000);
    const raw = await readFile(join(dir, 'proj-exit.queue.jsonl'), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(5);
  });

  // Regression (Lens B re-verify NEW-1): `await shutdown()` as the last activity
  // on an otherwise-idle loop must NOT hang on the unref'd debounce timer, and
  // must persist the buffer. Before the fix this child hung until the 3s kill.
  it('`await shutdown()` as the last loop activity resolves quickly and persists the buffer', async () => {
    const t0 = Date.now();
    const { stdout } = await execFileAsync(process.execPath, [fixture('shutdown-idle.mjs')], { timeout: 3_000 });
    expect(Date.now() - t0).toBeLessThan(3_000);
    const { ms, lines } = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(ms).toBeLessThan(1_000); // resolves promptly, not stuck on the 250ms+ debounce hang
    expect(lines).toBe(5); // all buffered events durably persisted
  });

  // Regression (Lens B re-verify round 2): the same idle-loop debounce hang lived
  // in restore(). After a restart that restores a non-empty queue, `await
  // shutdown()` must resolve AND persist the post-restore events (before the fix
  // it hung and the 5 new events were silently lost).
  it('after a restart with a restored queue, `await shutdown()` resolves and keeps new events', async () => {
    const port = await refusedPort();
    void port; // fixture uses a dead port internally
    await execFileAsync(process.execPath, [fixture('restart-shutdown.mjs'), dir, 'A'], { timeout: 3_000 });
    const t0 = Date.now();
    const { stdout } = await execFileAsync(process.execPath, [fixture('restart-shutdown.mjs'), dir, 'B'], { timeout: 3_000 });
    expect(Date.now() - t0).toBeLessThan(3_000);
    const { ms, lines } = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(ms).toBeLessThan(1_000); // restore path no longer hangs shutdown()
    expect(lines).toBe(15); // 10 restored + 5 new, none lost
  });
});

describe('handles & timers never keep the process alive', () => {
  it('the flush timer is unref()ed', async () => {
    const core = new MuonCore(coreConfig(dir, `${server.url}/api/track/batch`));
    cores.push(core);
    const timer = (core as unknown as { timer: NodeJS.Timeout }).timer;
    expect(timer.hasRef()).toBe(false);
  });

  it('a full init→track→flush→shutdown cycle leaves no new ref’d handles behind', async () => {
    type Handle = { hasRef?: () => boolean };
    const getHandles = (process as unknown as { _getActiveHandles?: () => Handle[] })._getActiveHandles;
    if (!getHandles) return; // private API not available — covered by the child fixture anyway
    const refCount = (): number => getHandles.call(process).filter((h) => h.hasRef?.() === true).length;
    const before = refCount();
    init('proj-1', server.url, { queueDir: dir });
    track('handle-check');
    await flush();
    await shutdown();
    await new Promise((r) => setTimeout(r, 50));
    expect(refCount()).toBeLessThanOrEqual(before);
  });
});

describe('shutdown & flush interplay', () => {
  it('shutdown() twice is safe and idempotent', async () => {
    init('proj-1', server.url, { queueDir: dir });
    track('one');
    const a = shutdown();
    const b = shutdown();
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
    await expect(shutdown()).resolves.toBeUndefined(); // and a third time
    expect(server.allEvents().map((e) => e.name)).toEqual(['one']);
  });

  it('flush() during shutdown() is safe', async () => {
    init('proj-1', server.url, { queueDir: dir });
    track('one');
    const closing = shutdown();
    await expect(flush()).resolves.toBeUndefined();
    await closing;
    expect(server.allEvents()).toHaveLength(1);
  });

  it('track() after shutdown() is a silent no-op', async () => {
    init('proj-1', server.url, { queueDir: dir });
    await shutdown();
    expect(() => track('ghost')).not.toThrow();
    await flush();
    expect(server.requests()).toBe(0);
  });

  it('core.shutdown() performs a final best-effort flush', async () => {
    const core = new MuonCore(coreConfig(dir, `${server.url}/api/track/batch`));
    cores.push(core);
    core.track('final');
    await core.shutdown();
    expect(server.allEvents().map((e) => e.name)).toEqual(['final']);
    // and is idempotent at the core level too
    await core.shutdown();
    expect(server.requests()).toBe(1);
  });
});

describe('automatic flushing', () => {
  it('flushes when the buffer reaches flushAt, without an explicit flush()', async () => {
    const core = new MuonCore(coreConfig(dir, `${server.url}/api/track/batch`, { flushAt: 3 }));
    cores.push(core);
    core.track('a');
    core.track('b');
    core.track('c'); // hits the threshold
    for (let i = 0; i < 100 && server.allEvents().length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    expect(server.allEvents().map((e) => e.name)).toEqual(['a', 'b', 'c']);
  });

  it('flushes on the interval timer even below flushAt', async () => {
    const core = new MuonCore(coreConfig(dir, `${server.url}/api/track/batch`, { flushAt: 1_000, flushIntervalMs: 150 }));
    cores.push(core);
    core.track('timer-flushed');
    for (let i = 0; i < 100 && server.allEvents().length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(server.allEvents().map((e) => e.name)).toEqual(['timer-flushed']);
  });
});

describe('10k tight-loop tracking', () => {
  it('stays bounded in memory and keeps the event loop responsive (<50ms max lag)', async () => {
    const core = new MuonCore(coreConfig(dir, `${server.url}/api/track/batch`, { flushAt: 100_000, maxQueueEvents: 10_000 }));
    cores.push(core);

    let maxLag = 0;
    let last = performance.now();
    const sampler = setInterval(() => {
      const now = performance.now();
      const lag = now - last - 10;
      if (lag > maxLag) maxLag = lag;
      last = now;
    }, 10);

    for (let i = 0; i < 10_500; i++) core.track('burst', { i });

    await new Promise((r) => setTimeout(r, 200)); // let persistence catch up while sampling
    clearInterval(sampler);

    expect(core.bufferedCount()).toBe(10_000); // capped, oldest dropped
    expect(maxLag).toBeLessThan(50);
    await core.settled(); // persisted without issue
    await core.flush();
    expect(server.allEvents()).toHaveLength(10_000);
  });
});
