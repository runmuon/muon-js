// Child: track many events, then return WITHOUT shutdown/flush. Realistic
// "process exit" lifecycle: beforeExit best-effort flush must NOT hang the exit.
// Prints a heartbeat right before falling off the end; the harness measures
// how long until the process actually exits.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';
const N = Number(process.argv[2] || 16000);
const qd = mkdtempSync(join(tmpdir(), 'muon-hn-'));
muon.init('c', 'http://127.0.0.1:9', { queueDir: qd, flushAt: 5_000_000, maxQueueEvents: 10000 });
const t0 = Date.now();
for (let i = 0; i < N; i++) muon.track('e', { a: i, b: 'x'.repeat(80) });
console.log('tracked', N, 'in', Date.now() - t0, 'ms; falling off end now at', Date.now());
// no shutdown — see how long the process lingers.
