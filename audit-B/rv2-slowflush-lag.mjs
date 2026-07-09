// RV2 (B1 re-verify): during a slow flush (server trickles the response body
// byte-by-byte over ~1.5s), the event loop must stay responsive. We keep a
// 10ms setInterval heartbeat and monitorEventLoopDelay running; assert max lag
// < 50ms (gzip is async, fetch is async, no sync IO on the flush path).
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import * as muon from '../dist/index.js';

const srv = createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // dribble a JSON body one byte at a time
    const body = JSON.stringify({ processed: 1000 });
    let i = 0;
    const iv = setInterval(() => {
      if (i < body.length) { res.write(body[i++]); return; }
      clearInterval(iv);
      res.end();
    }, 15);
  });
});

srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const qd = mkdtempSync(join(tmpdir(), 'muon-rv2-'));
  muon.init('c', `http://127.0.0.1:${port}`, { queueDir: qd, flushAt: 5_000_000, requestTimeout: 10_000 });
  for (let i = 0; i < 500; i++) muon.track('e', { i, pad: 'y'.repeat(200) });

  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  let beats = 0, maxGap = 0, last = performance.now();
  const hb = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last - 10);
    last = now; beats++;
  }, 10);

  const t0 = performance.now();
  await muon.flush();
  const flushMs = performance.now() - t0;
  clearInterval(hb);
  h.disable();

  console.log(JSON.stringify({
    probe: 'rv2-slowflush-lag',
    flushMs: Math.round(flushMs),
    heartbeats: beats,
    heartbeatMaxExtraGapMs: Math.round(maxGap),
    loopLagMaxMs: +(h.max / 1e6).toFixed(1),
    loopLagP99Ms: +(h.percentile(99) / 1e6).toFixed(1),
    ASSERT_lagUnder50ms: (h.max / 1e6) < 50,
  }));
  srv.close();
  await muon.shutdown();
  process.exit(0);
});
