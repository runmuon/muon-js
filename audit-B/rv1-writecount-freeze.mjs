// RV1 (B1 re-verify): 100k SYNC track(). Assert:
//  - track() does NO inline disk IO: the sync loop is fast, event-loop lag tiny.
//  - disk writes are O(1) not O(N): count writeSnapshot cycles via .tmp appearances.
//  - shutdown() drain is ms, not minutes (no per-track full-buffer serialize).
import { mkdtempSync, watch, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const N = Number(process.argv[2] || 100000);
const qd = mkdtempSync(join(tmpdir(), 'muon-rv1-'));
const muon = await import('../dist/index.js');

let tmpEvents = 0;   // filename ends with .tmp  -> proxy for writeSnapshot count (~2/snapshot)
let queueEvents = 0; // filename == the queue file
const w = watch(qd, (evt, name) => {
  if (!name) return;
  if (name.endsWith('.tmp')) tmpEvents++;
  else if (name.endsWith('.queue.jsonl')) queueEvents++;
});

// flushAt huge so nothing network-flushes; isolate the PERSIST path.
muon.init('rv1', 'http://127.0.0.1:9', { queueDir: qd, flushAt: 50_000_000, maxQueueEvents: 10000 });

const h = monitorEventLoopDelay({ resolution: 1 });
h.enable();
const tSync0 = performance.now();
for (let i = 0; i < N; i++) muon.track('e', { a: i, b: 'x'.repeat(80) });
const syncMs = performance.now() - tSync0;

// let the debounce fire + all writes drain
const tDrain0 = performance.now();
await muon.shutdown();
const drainMs = performance.now() - tDrain0;
h.disable();
w.close();

let bytes = 0, lines = 0;
try {
  bytes = statSync(join(qd, 'rv1.queue.jsonl')).size;
  lines = readFileSync(join(qd, 'rv1.queue.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length;
} catch {}

console.log(JSON.stringify({
  probe: 'rv1-writecount-freeze', N,
  syncLoopMs: Math.round(syncMs),
  shutdownDrainMs: Math.round(drainMs),
  loopLagMaxMs: +(h.max / 1e6).toFixed(1),
  loopLagP99Ms: +(h.percentile(99) / 1e6).toFixed(1),
  tmpFileEvents: tmpEvents,
  queueFileEvents: queueEvents,
  approxSnapshotWrites: Math.round(tmpEvents / 2) || tmpEvents,
  finalQueueLines: lines, finalQueueBytes: bytes,
  ASSERT_writesAreO1: tmpEvents < 100,
  // The sync for-loop of N track() is itself one JS block; the freeze metric is
  // syncLoopMs (was 2.6s @100k in B1 due to inline full-buffer serialize).
  ASSERT_syncLoopFast: syncMs < 1000,
  ASSERT_drainSeconds: drainMs < 5000,
  note: 'loopLagMax includes the unavoidable sync for-loop block; syncLoopMs is the freeze metric',
}));
process.exit(0);
