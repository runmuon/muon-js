// P6: a large pre-existing queue file. restore() does readFile (whole file into
// memory) + split('\n') + JSON.parse per line, all on the event loop. Measure
// the block and peak memory. Also tests: is the loaded queue re-capped so it
// can't blow memory? (restore trims AFTER unshifting everything in.)
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const qd = mkdtempSync(join(tmpdir(), 'muon-p6-'));
const qf = join(qd, 'c.queue.jsonl');

// Write a big queue file: 500k lines (far above maxQueueEvents=10k default).
const LINES = 500000;
let buf = '';
const parts = [];
for (let i = 0; i < LINES; i++) {
  parts.push(JSON.stringify({ project: 'c', type: 'custom', name: 'e', properties: { id: i, pad: 'x'.repeat(40) } }));
  if (parts.length === 10000) { buf += parts.join('\n') + '\n'; parts.length = 0; }
}
if (parts.length) buf += parts.join('\n') + '\n';
writeFileSync(qf, buf);
const fileMB = +(Buffer.byteLength(buf) / 1048576).toFixed(1);
buf = '';

const rss0 = process.memoryUsage().rss;
const h = monitorEventLoopDelay({ resolution: 5 });
h.enable();
const t0 = performance.now();

const muon = await import('../dist/index.js');
muon.init('c', 'http://127.0.0.1:9', { queueDir: qd, flushAt: 5_000_000, maxQueueEvents: 10000 });
// settled() waits for restore to finish
await muon.default.shutdown ? null : null;
// use the internal settle via flush() which awaits ready
await muon.flush();
const restoreMs = performance.now() - t0;
h.disable();
const rssPeakMB = +((process.memoryUsage().rss - rss0) / 1048576).toFixed(1);

console.log(JSON.stringify({
  probe: 'p6-huge-queue',
  fileLines: LINES, fileMB,
  restorePlusFirstFlushMs: Math.round(restoreMs),
  loopDelayP99Ms: Math.round(h.percentile(99) / 1e6),
  loopDelayMaxMs: Math.round(h.max / 1e6),
  rssDeltaMB: rssPeakMB,
  note: 'whole file read into one string + parsed line-by-line on the loop before trim to 10k',
}));
await muon.shutdown();
process.exit(0);
