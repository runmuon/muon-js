// P1b: how does post-track drain/shutdown time scale with N track() calls?
// No network involved (flushAt huge, but we DON'T flush to network; queueDir valid).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function runN(N) {
  const muon = await import('../dist/index.js?bust=' + N); // fresh module each time
  const qd = mkdtempSync(join(tmpdir(), 'muon-p1b-'));
  muon.init('p1b', 'http://127.0.0.1:9', { queueDir: qd, flushAt: 5_000_000, maxQueueEvents: 10000 });
  const props = () => ({ a: 1, b: 'x'.repeat(100), c: [1, 2, 3], d: { e: 'y'.repeat(50) } });
  const t0 = performance.now();
  for (let i = 0; i < N; i++) muon.track('e', props());
  const loopMs = performance.now() - t0;
  const t1 = performance.now();
  await muon.shutdown();
  const drainMs = performance.now() - t1;
  return { N, loopMs: Math.round(loopMs), drainMs: Math.round(drainMs) };
}

for (const N of [2000, 4000, 8000, 16000, 32000]) {
  const r = await runN(N);
  console.log(JSON.stringify(r));
}
process.exit(0);
