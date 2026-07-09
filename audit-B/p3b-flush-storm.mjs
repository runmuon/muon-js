// P3b: does doFlush honor backoff? Synchronously track many events past flushAt
// against an always-503 server. Each track past flushAt queues its own flush();
// doFlush has no retryAt gate, so all queued flushes may fire back-to-back =
// a retry storm sending the SAME re-queued events repeatedly.
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';

const hits = [];
const srv = createServer((req, res) => {
  hits.push(Date.now());
  req.on('data', () => {});
  req.on('end', () => { res.writeHead(503); res.end(); });
});
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const qd = mkdtempSync(join(tmpdir(), 'muon-p3b-'));
  muon.init('c', `http://127.0.0.1:${port}`, { queueDir: qd, flushAt: 20, requestTimeout: 1000 });
  const t0 = Date.now();
  // one synchronous burst of 1000 track() calls
  for (let i = 0; i < 1000; i++) muon.track('e', { i });
  // let the queued flush chain run for 2s
  await new Promise((r) => setTimeout(r, 2000));
  const gaps = [];
  for (let i = 1; i < hits.length; i++) gaps.push(hits[i] - hits[i - 1]);
  const within500ms = hits.filter((h) => h - t0 < 500).length;
  console.log(JSON.stringify({
    probe: 'p3b-flush-storm',
    trackCalls: 1000, flushAt: 20,
    totalAttemptsIn2s: hits.length,
    attemptsWithinFirst500ms: within500ms,
    firstTenGapsMs: gaps.slice(0, 10),
    verdict: hits.length > 20 ? 'STORM: backoff not enforced across queued flushes' : 'bounded',
  }));
  srv.close();
  await muon.shutdown();
  process.exit(0);
});
