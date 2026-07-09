import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MuonCore, type CoreConfig } from '../src/core.js';
import { QueueStore } from '../src/queue.js';
import { installLeakGuard, drainMicrotasks } from './leakguard.js';

// Always 'retry' -> batch re-queued, nothing ever delivered, buffer preserved.
const neverSend = { send: async () => ({ outcome: 'retry' as const }) };

function cfg(dir: string, cap: number): CoreConfig {
  return {
    projectId: 'p', batchUrl: 'http://127.0.0.1:1/api/track/batch',
    flushAt: 1e9, flushIntervalMs: 1e9, maxQueueEvents: cap,
    requestTimeoutMs: 500, debug: false, queueDir: dir,
    maxErrorsPerRun: 1e9, maxDuplicateErrors: 1e9,
  };
}

describe('end-to-end: large uncapped queue silently wiped on restart', () => {
  it('cap=200k, enqueue 200k, persist, restart -> restore yields 0 (total silent loss)', async () => {
    const leaks = installLeakGuard();
    const dir = mkdtempSync(join(tmpdir(), 'muon-rt-'));
    try {
      const store1 = new QueueStore(dir, 'p');
      const core1 = new MuonCore(cfg(dir, 200_000), store1, neverSend as any);
      await core1.settled();
      for (let i = 0; i < 200_000; i++) core1.track('e' + i);
      expect(core1.bufferedCount()).toBe(200_000); // buffer grew way past default 10k cap
      await store1.settle();
      await core1.shutdown();
      const sz = statSync(store1.queueFile).size;
      const lines = readFileSync(store1.queueFile, 'utf8').split('\n').filter(Boolean).length;
      console.log('persisted queueFile bytes=', sz, 'lines=', lines);
      expect(lines).toBe(200_000);

      // Simulate process restart: new core restores from the same file.
      const store2 = new QueueStore(dir, 'p');
      const core2 = new MuonCore(cfg(dir, 200_000), store2, neverSend as any);
      await core2.settled();
      await drainMicrotasks();
      console.log('RESTORED bufferedCount=', core2.bufferedCount());
      // FINDING: all 200k persisted events are gone (unshift spread RangeError).
      expect(core2.bufferedCount()).toBe(0);
      await core2.shutdown();
      expect(leaks.exceptions).toEqual([]);
      expect(leaks.rejections).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      leaks.stop();
    }
  });
});
