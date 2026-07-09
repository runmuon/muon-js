// P5: repeat init->track->shutdown 500x in ONE process. RSS + handle count +
// beforeExit listener count must be flat, not monotonically rising.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';

const qd = mkdtempSync(join(tmpdir(), 'muon-p5-'));
function rssMB() { return +(process.memoryUsage().rss / 1048576).toFixed(1); }

const samples = [];
const CYCLES = 500;
for (let c = 0; c < CYCLES; c++) {
  muon.init('c', 'http://127.0.0.1:9', { queueDir: qd, flushAt: 1000 });
  for (let i = 0; i < 20; i++) muon.track('e', { c, i, pad: 'x'.repeat(50) });
  await muon.shutdown();
  if (c % 50 === 0 || c === CYCLES - 1) {
    if (global.gc) global.gc();
    samples.push({
      cycle: c,
      rssMB: rssMB(),
      handles: process._getActiveHandles().length,
      beforeExitListeners: process.listenerCount('beforeExit'),
      uncaughtMonitorListeners: process.listenerCount('uncaughtExceptionMonitor'),
      unhandledRejListeners: process.listenerCount('unhandledRejection'),
    });
  }
}
for (const s of samples) console.log(JSON.stringify(s));
process.exit(0);
