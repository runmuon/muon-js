// P1c: count disk writes to the queue file for N track() calls.
// Coalescing SHOULD collapse a burst of N enqueues into ~1 write. Measure reality.
import { mkdtempSync, watch, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const N = 3000;
const qd = mkdtempSync(join(tmpdir(), 'muon-p1c-'));
const muon = await import('../dist/index.js');
muon.init('p1c', 'http://127.0.0.1:9', { queueDir: qd, flushAt: 5_000_000, maxQueueEvents: 10000 });

let writeEvents = 0;
const w = watch(qd, (evt, name) => {
  if (name && name.startsWith('p1c') && name.endsWith('.queue.jsonl')) writeEvents++;
});

for (let i = 0; i < N; i++) muon.track('e', { a: i, b: 'x'.repeat(80) });
await muon.shutdown();
w.close();

let bytes = 0;
try { bytes = statSync(join(qd, 'p1c.queue.jsonl')).size; } catch {}
console.log(JSON.stringify({
  probe: 'p1c-writecount', N,
  fileChangeEvents: writeEvents,
  approxWritesPerTrack: +(writeEvents / N).toFixed(2),
  finalQueueBytes: bytes,
  note: 'ideal coalesced writes ≈ 1-2; fileChangeEvents≈N means one full-buffer rewrite per track',
}));
process.exit(0);
