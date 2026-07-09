// Killer fixture (write-storm variant): init + a LARGE synchronous burst of
// track(), then NO shutdown(). The process must still exit on its own quickly —
// the coalesced, unref'd disk writes may never linger the exit (the old bug made
// a no-shutdown child hang ~15s while it serialized the whole buffer per event).
// argv: <port> <queueDir> <N>
import { init, track } from '../../dist/index.js';

const [, , port, queueDir, nStr] = process.argv;
const N = Number(nStr || 50_000);
init('proj-burst', `http://127.0.0.1:${port}`, {
  queueDir,
  requestTimeout: 500,
  flushAt: 5_000_000, // never threshold-flush; force the exit path to cope with a full buffer
  maxQueueEvents: 10_000,
});
const t0 = Date.now();
for (let i = 0; i < N; i++) track('burst', { i, pad: 'x'.repeat(40) });
console.log('TRACKED', N, 'in', Date.now() - t0);
// no shutdown — beforeExit gets ONE bounded best-effort flush, then exit.
