// RV8 (NEW-bug hunt): hammer the coalescing + forceDrain + await-persist paths.
// Concurrent producers + a swarm of flush() + a server that DIES mid-flight
// (destroys in-flight sockets) then recovers, then a shutdown racing late
// track()s. Assert: at-least-once (every id is delivered OR still on disk),
// queue file parses, no unhandledRejection, shutdown resolves (no deadlock
// where `writing` never clears / no hang).
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';

let unhandled = 0, uncaught = 0;
process.on('unhandledRejection', () => { unhandled++; });
process.on('uncaughtException', () => { uncaught++; });

const seen = new Map();
let reqCount = 0;
let killWindow = false;

function record(buf) {
  try {
    const json = JSON.parse(gunzipSync(buf).toString('utf8'));
    for (const ev of json.events) {
      if (ev.properties && typeof ev.properties.id === 'number') {
        seen.set(ev.properties.id, (seen.get(ev.properties.id) || 0) + 1);
      }
    }
  } catch {}
}

const srv = createServer((req, res) => {
  reqCount++;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // During the kill window, destroy the socket mid-response (transient fault).
    if (killWindow) { req.destroy(); try { res.destroy(); } catch {} return; }
    record(Buffer.concat(chunks));
    res.writeHead(200); res.end(JSON.stringify({ processed: 0 }));
  });
});

srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const qd = mkdtempSync(join(tmpdir(), 'muon-rv8-'));
  const qf = join(qd, 'c.queue.jsonl');
  muon.init('c', `http://127.0.0.1:${port}`, { queueDir: qd, flushAt: 40, maxQueueEvents: 200000, requestTimeout: 400 });

  const TOTAL = 6000;
  let id = 0;
  // open the kill window partway through, close it later => forces retry/requeue
  // interleaved with fresh enqueues and coalesced persists.
  setTimeout(() => { killWindow = true; }, 60);
  setTimeout(() => { killWindow = false; }, 320);

  const producers = [];
  for (let p = 0; p < 4; p++) {
    producers.push((async () => {
      for (let i = 0; i < TOTAL / 4; i++) {
        muon.track('e', { id: id++ });
        if (i % 25 === 0) { muon.flush(); await new Promise((r) => setImmediate(r)); }
      }
    })());
  }
  // a swarm of concurrent flush() racing the producers and the server death
  const swarm = Array.from({ length: 1500 }, () => muon.flush());
  await Promise.all(producers);
  await Promise.all(swarm);

  // drain: keep flushing until the queue empties or we time out
  const drainDeadline = Date.now() + 8000;
  while (Date.now() < drainDeadline) {
    await muon.flush();
    if (muon.default && false) break;
    // peek disk: stop when nothing residual and server got everything
    await new Promise((r) => setTimeout(r, 60));
    if (seen.size >= id) break;
  }

  // race shutdown against late track()s
  const sd = muon.shutdown();
  muon.track('e', { id: id++ }); // must be dropped
  muon.track('e', { id: id++ });
  const sdStart = Date.now();
  await sd;
  const shutdownMs = Date.now() - sdStart;
  await new Promise((r) => setTimeout(r, 300)); // let last in-flight requests land

  // at-least-once = delivered OR persisted on disk
  const diskIds = new Set();
  let queueOk = true, residual = 0;
  if (existsSync(qf)) {
    for (const l of readFileSync(qf, 'utf8').split('\n')) {
      if (!l.trim()) continue; residual++;
      try { const ev = JSON.parse(l); if (ev.properties && typeof ev.properties.id === 'number') diskIds.add(ev.properties.id); }
      catch { queueOk = false; }
    }
  }
  const attempted = id - 2; // exclude the two during-shutdown tracks
  let lost = 0, maxDup = 0;
  for (let i = 0; i < attempted; i++) {
    const delivered = seen.get(i) || 0;
    if (delivered === 0 && !diskIds.has(i)) lost++;
    if (delivered > maxDup) maxDup = delivered;
  }
  const shutdownLeaked = diskIds.has(id - 1) || diskIds.has(id - 2) || seen.has(id - 1) || seen.has(id - 2);

  console.log(JSON.stringify({
    probe: 'rv8-newbug-concurrency',
    attempted, distinctDelivered: seen.size, serverRequests: reqCount,
    lostNeitherDeliveredNorPersisted: lost,
    maxDupCount: maxDup,
    residualQueueLines: residual, queueFileParseOk: queueOk,
    duringShutdownTrackLeaked: shutdownLeaked,
    shutdownResolveMs: shutdownMs,
    unhandledRejections: unhandled, uncaughtExceptions: uncaught,
    ASSERT_noLoss: lost === 0,
    ASSERT_noCorruption: queueOk,
    ASSERT_noUnhandled: unhandled === 0 && uncaught === 0,
    ASSERT_shutdownResolvedFast: shutdownMs < 3000,
    ASSERT_droppedDuringShutdown: !shutdownLeaked,
  }));
  srv.close();
  process.exit(0);
});
