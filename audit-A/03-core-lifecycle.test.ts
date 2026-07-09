import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MuonCore, type CoreConfig } from '../src/core.js';
import { QueueStore } from '../src/queue.js';
import type { MuonEvent } from '../src/event.js';
import { installLeakGuard, drainMicrotasks } from './leakguard.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'muon-core-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

function cfg(over: Partial<CoreConfig> = {}): CoreConfig {
  return {
    projectId: 'p', batchUrl: 'http://127.0.0.1:1/api/track/batch',
    flushAt: 20, flushIntervalMs: 60_000, maxQueueEvents: 10_000,
    requestTimeoutMs: 500, debug: false, queueDir: root,
    maxErrorsPerRun: 100, maxDuplicateErrors: 5, ...over,
  };
}
const okTransport = { send: async () => ({ outcome: 'ok' as const, status: 200 }) };

describe('MuonCore.restore with a hostile pre-existing queue file', () => {
  it('huge persisted file: does unshift(...persisted) spread blow the arg limit?', async () => {
    const leaks = installLeakGuard();
    const q = new QueueStore(root, 'p');
    // write 2,000,000 valid lines directly to the queue file
    const line = JSON.stringify({ project: 'p', type: 'custom', name: 'e' } satisfies MuonEvent) + '\n';
    writeFileSync(q.queueFile, line.repeat(2_000_000));
    const core = new MuonCore(cfg({ maxQueueEvents: 10 }), q, okTransport as any);
    await core.settled();
    await drainMicrotasks();
    console.log('after huge restore bufferedCount=', core.bufferedCount(), 'exceptions=', leaks.exceptions.length, 'rejections=', leaks.rejections.length);
    // If restore threw internally it is caught, but was the buffer trimmed correctly?
    expect(core.bufferedCount()).toBeLessThanOrEqual(10);
    await core.shutdown();
    expect(leaks.exceptions).toEqual([]);
    expect(leaks.rejections).toEqual([]);
    leaks.stop();
  });
});

describe('MuonCore flush concurrency & lifecycle', () => {
  it('flush() 100x concurrently never rejects', async () => {
    const leaks = installLeakGuard();
    const core = new MuonCore(cfg(), new QueueStore(root, 'p'), okTransport as any);
    for (let i = 0; i < 50; i++) core.track('e' + i);
    const flushes = Array.from({ length: 100 }, () => core.flush());
    // flush() must always return a promise that resolves
    await Promise.all(flushes);
    await drainMicrotasks();
    expect(leaks.rejections).toEqual([]);
    await core.shutdown();
    leaks.stop();
  });

  it('transport that REJECTS is contained (send throws)', async () => {
    const leaks = installLeakGuard();
    const throwingTransport = { send: async () => { throw new Error('transport blew up'); } };
    const core = new MuonCore(cfg(), new QueueStore(root, 'p'), throwingTransport as any);
    core.track('x');
    await core.flush();
    await drainMicrotasks();
    console.log('throwing transport rejections=', leaks.rejections.length);
    expect(leaks.rejections).toEqual([]);
    await core.shutdown();
    leaks.stop();
  });

  it('shutdown twice + flush during shutdown', async () => {
    const leaks = installLeakGuard();
    const core = new MuonCore(cfg(), new QueueStore(root, 'p'), okTransport as any);
    core.track('a');
    const s1 = core.shutdown();
    const f = core.flush(); // during shutdown
    const s2 = core.shutdown();
    await Promise.all([s1, s2, f]);
    await drainMicrotasks();
    expect(leaks.rejections).toEqual([]);
    // track after shutdown is dropped
    core.track('after');
    expect(core.bufferedCount()).toBe(0);
    leaks.stop();
  });

  it('captureError with hostile values via core', async () => {
    const leaks = installLeakGuard();
    const core = new MuonCore(cfg(), new QueueStore(root, 'p'), okTransport as any);
    const circular: any = {}; circular.self = circular;
    for (const v of [null, undefined, '', 'str', 42, {}, [], circular, Symbol('s') as any, new Error('e')]) {
      expect(() => core.captureError(v)).not.toThrow();
    }
    await drainMicrotasks();
    expect(leaks.rejections).toEqual([]);
    await core.shutdown();
    leaks.stop();
  });
});
