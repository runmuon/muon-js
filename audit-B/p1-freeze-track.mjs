// P1: event-loop lag while firing 100k track() with largish properties.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';

const qd = mkdtempSync(join(tmpdir(), 'muon-p1-'));
// Point at a dead port so no real network happens; we only measure enqueue cost.
muon.init('p1', 'http://127.0.0.1:9', { queueDir: qd, flushAt: 1000000, maxQueueEvents: 10000 });

const h = monitorEventLoopDelay({ resolution: 10 });

// Build a largish property object (~50 keys, nested)
function props(i) {
  const o = { i, ts: Date.now(), tag: 'x'.repeat(200) };
  for (let k = 0; k < 40; k++) o['k' + k] = { a: k, b: 'v'.repeat(50), c: [1, 2, 3, k] };
  return o;
}

const N = 100000;
h.enable();
const t0 = performance.now();
let maxSyncGap = 0;
let last = performance.now();
for (let i = 0; i < N; i++) {
  muon.track('evt_' + (i % 100), props(i));
  if ((i & 1023) === 0) {
    const now = performance.now();
    if (now - last > maxSyncGap) maxSyncGap = now - last;
    last = now;
  }
}
const syncMs = performance.now() - t0;
h.disable();

// The 100k loop is synchronous JS; measure how long the event loop was blocked
// as a single contiguous block (nothing else could run during the loop).
console.log(JSON.stringify({
  probe: 'p1-freeze-track',
  N,
  syncLoopMs: Math.round(syncMs),
  perTrackUs: Math.round((syncMs / N) * 1000),
  loopDelayP99Ms: Math.round(h.percentile(99) / 1e6),
  loopDelayMaxMs: Math.round(h.max / 1e6),
  buffered: muon.default ? undefined : undefined,
}));

// Now measure recovery: how long until the loop is responsive again + persist drains.
const rec = monitorEventLoopDelay({ resolution: 10 });
rec.enable();
const r0 = performance.now();
await muon.shutdown();
rec.disable();
console.log(JSON.stringify({
  phase: 'drain+shutdown',
  drainMs: Math.round(performance.now() - r0),
  drainP99Ms: Math.round(rec.percentile(99) / 1e6),
  drainMaxMs: Math.round(rec.max / 1e6),
}));
process.exit(0);
