// P3: server instantly 503s forever. Assert SDK backs off (few, growing-gap
// attempts, capped) and does NOT spin CPU or grow memory.
import { createServer } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';

const hits = [];
const srv = createServer((req, res) => {
  hits.push(Date.now());
  req.on('data', () => {});
  req.on('end', () => { res.writeHead(503); res.end('nope'); });
});
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const qd = mkdtempSync(join(tmpdir(), 'muon-p3-'));
  // flushAt low so it wants to send; keep tracking to exercise auto-flush gating.
  muon.init('c', `http://127.0.0.1:${port}`, { queueDir: qd, flushAt: 5, requestTimeout: 1000 });

  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const cpu0 = process.cpuUsage();
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();

  // keep producing events for 5s so both auto-flush and the interval fire
  const iv = setInterval(() => { for (let i = 0; i < 10; i++) muon.track('e', { t: Date.now() }); }, 100);

  await new Promise((r) => setTimeout(r, 5000));
  clearInterval(iv);
  h.disable();
  const cpu = process.cpuUsage(cpu0);
  const rssDelta = process.memoryUsage().rss - rss0;

  const gaps = [];
  for (let i = 1; i < hits.length; i++) gaps.push(hits[i] - hits[i - 1]);
  console.log(JSON.stringify({
    probe: 'p3-retry-storm',
    windowMs: Date.now() - t0,
    attempts: hits.length,
    gapsMs: gaps,
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSysMs: Math.round(cpu.system / 1000),
    loopDelayP99Ms: Math.round(h.percentile(99) / 1e6),
    loopDelayMaxMs: Math.round(h.max / 1e6),
    rssDeltaMB: +(rssDelta / 1048576).toFixed(1),
  }));
  srv.close();
  await muon.shutdown();
  process.exit(0);
});
