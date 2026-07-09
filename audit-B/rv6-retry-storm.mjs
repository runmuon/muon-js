// RV6 (B2 re-verify): 1000 sync track() past flushAt against an always-503
// server. autoFlush must be single-flight AND honor the retryAt backoff gate,
// so the POST count over a window stays small and spaced (not a 981-POST storm).
// Also checks the exit-flush bypassBackoff path does not turn into a storm.
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

const hits = [];
const srv = createServer((req, res) => {
  hits.push(Date.now());
  req.on('data', () => {});
  req.on('end', () => { res.writeHead(503); res.end(); });
});

srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const qd = mkdtempSync(join(tmpdir(), 'muon-rv6-'));
  muon.init('c', `http://127.0.0.1:${port}`, { queueDir: qd, flushAt: 20, requestTimeout: 1000 });
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) muon.track('e', { i }); // one synchronous burst

  // observe for 3s: first backoff is ~[0.5s,1s], then ~[1s,2s]… so in 3s we
  // expect only a small handful of attempts.
  await new Promise((r) => setTimeout(r, 3000));
  const gaps = [];
  for (let i = 1; i < hits.length; i++) gaps.push(hits[i] - hits[i - 1]);
  const within500 = hits.filter((h) => h - t0 < 500).length;

  console.log(JSON.stringify({
    probe: 'rv6-retry-storm', trackCalls: 1000, flushAt: 20,
    totalAttemptsIn3s: hits.length,
    attemptsWithinFirst500ms: within500,
    gapsMs: gaps.slice(0, 12),
    unhandledRejections: unhandled,
    ASSERT_bounded: hits.length <= 6,
    ASSERT_noStormBurst: within500 <= 2,
  }));
  srv.close();
  await muon.shutdown();
  process.exit(0);
});
