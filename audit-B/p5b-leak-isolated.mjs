// P5b: like P5 but a FRESH queueDir each cycle so the on-disk queue can't
// accumulate. Isolates a genuine in-process object/promise leak from the
// shared-queue artifact. RSS should be flat.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';

function rssMB() { return +(process.memoryUsage().rss / 1048576).toFixed(1); }
const samples = [];
const CYCLES = 500;
for (let c = 0; c < CYCLES; c++) {
  const qd = mkdtempSync(join(tmpdir(), 'muon-p5b-'));
  muon.init('c', 'http://127.0.0.1:9', { queueDir: qd, flushAt: 1000, maxQueueEvents: 100 });
  for (let i = 0; i < 20; i++) muon.track('e', { c, i });
  await muon.shutdown();
  if (c % 100 === 0 || c === CYCLES - 1) {
    if (global.gc) { global.gc(); global.gc(); }
    samples.push({ cycle: c, rssMB: rssMB(), handles: process._getActiveHandles().length,
      beforeExitL: process.listenerCount('beforeExit') });
  }
}
for (const s of samples) console.log(JSON.stringify(s));
process.exit(0);
