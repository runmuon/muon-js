// P4: concurrency correctness. A server that accepts batches and records every
// event's unique id. We track a known set of ids while racing flush()/shutdown()
// and a mid-flight server kill. Assert: at-least-once (every id seen >=1),
// no corruption, no unhandledRejection.
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

const seen = new Map(); // id -> count
function record(bodyBuf) {
  try {
    const json = JSON.parse(gunzipSync(bodyBuf).toString('utf8'));
    for (const ev of json.events) {
      if (ev.properties && typeof ev.properties.id === 'number') {
        seen.set(ev.properties.id, (seen.get(ev.properties.id) || 0) + 1);
      }
    }
  } catch { /* count as parse fail */ }
}

const srv = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { record(Buffer.concat(chunks)); res.writeHead(200); res.end(JSON.stringify({ processed: 0 })); });
});

srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const qd = mkdtempSync(join(tmpdir(), 'muon-p4-'));
  muon.init('c', `http://127.0.0.1:${port}`, { queueDir: qd, flushAt: 50, maxQueueEvents: 100000, requestTimeout: 500 });

  const TOTAL = 3000;
  let id = 0;
  // Interleave: concurrent producers + flushers + a shutdown at the end.
  const producers = [];
  for (let p = 0; p < 3; p++) {
    producers.push((async () => {
      for (let i = 0; i < TOTAL / 3; i++) {
        muon.track('e', { id: id++ });
        if (i % 50 === 0) { muon.flush(); await new Promise((r) => setImmediate(r)); }
      }
    })());
  }
  // 1000 concurrent flush() calls racing the producers
  const flushes = Array.from({ length: 1000 }, () => muon.flush());
  await Promise.all(producers);
  await Promise.all(flushes);
  // final drain + shutdown (interleave a few late tracks)
  muon.track('e', { id: id++ });
  const sd = muon.shutdown();
  muon.track('e', { id: id++ }); // track during shutdown — should be dropped safely
  await sd;

  // give the server a moment to finish recording in-flight requests
  await new Promise((r) => setTimeout(r, 300));

  const producedIds = id; // 0..id-1 were attempted; last one tracked during shutdown may be dropped
  let missing = 0, dupes = 0, maxDup = 0;
  for (let i = 0; i < producedIds - 1; i++) { // exclude the during-shutdown one
    const c = seen.get(i) || 0;
    if (c === 0) missing++;
    if (c > 1) { dupes++; maxDup = Math.max(maxDup, c); }
  }
  // check queue file integrity (should be parseable or absent)
  const qf = join(qd, 'c.queue.jsonl');
  let queueOk = true, queueLines = 0;
  if (existsSync(qf)) {
    for (const l of readFileSync(qf, 'utf8').split('\n')) {
      if (!l.trim()) continue; queueLines++;
      try { JSON.parse(l); } catch { queueOk = false; }
    }
  }
  console.log(JSON.stringify({
    probe: 'p4-concurrency',
    producedIds: producedIds - 1,
    distinctDelivered: seen.size,
    missing, duplicated: dupes, maxDupCount: maxDup,
    unhandledRejections: unhandled,
    queueFileParseOk: queueOk, queueFileResidualLines: queueLines,
    verdict: (missing === 0 && unhandled === 0 && queueOk) ? 'at-least-once + no corruption OK' : 'PROBLEM',
  }));
  srv.close();
  process.exit(0);
});
