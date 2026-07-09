// RV5 (NEW-bug hunt): coalescing correctness. The risk in the debounce +
// single-flight + forceDrain path is a LOST trailing write or a DOUBLE write.
// Dead port => nothing network-flushes, so the final on-disk file MUST equal
// the exact set of tracked events. We shutdown BEFORE the 250ms debounce fires,
// forcing settle()/forceDrain to carry the trailing write.
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

function readIds(qf) {
  if (!existsSync(qf)) return { ids: [], parseOk: true, lines: 0 };
  const ids = [], seen = new Set(); let parseOk = true, lines = 0, dup = 0;
  for (const l of readFileSync(qf, 'utf8').split('\n')) {
    if (!l.trim()) continue; lines++;
    try {
      const ev = JSON.parse(l);
      if (ev.properties && typeof ev.properties.id === 'number') {
        ids.push(ev.properties.id);
        if (seen.has(ev.properties.id)) dup++; else seen.add(ev.properties.id);
      }
    } catch { parseOk = false; }
  }
  return { ids, parseOk, lines, dup };
}

let cyclesLost = 0, cyclesDup = 0, cyclesBadParse = 0, worstDeadlockMs = 0;
const CYCLES = 300;
for (let c = 0; c < CYCLES; c++) {
  const qd = mkdtempSync(join(tmpdir(), 'muon-rv5-'));
  const qf = join(qd, 'c.queue.jsonl');
  const K = 1 + (c % 47); // 1..47 events, all below flushAt so none leave the buffer
  muon.init('c', 'http://127.0.0.1:9', { queueDir: qd, flushAt: 5_000_000, maxQueueEvents: 100000 });
  for (let i = 0; i < K; i++) muon.track('e', { id: i });
  // Interleave a flush() (dead port -> requeues) and shutdown WITHOUT awaiting the
  // debounce. settle() inside shutdown must carry the trailing write durably.
  if (c % 3 === 0) muon.flush();
  const t0 = performance.now();
  const sd = muon.shutdown();
  if (c % 5 === 0) muon.track('e', { id: 999999 }); // during-shutdown track must be dropped
  await sd;
  const dt = performance.now() - t0;
  if (dt > worstDeadlockMs) worstDeadlockMs = dt;

  const r = readIds(qf);
  const uniqueExpected = new Set(Array.from({ length: K }, (_, i) => i));
  const got = new Set(r.ids.filter((x) => x !== 999999));
  let lost = false;
  for (const e of uniqueExpected) if (!got.has(e)) lost = true;
  if (lost || got.size !== K) cyclesLost++;
  if (r.dup > 0) cyclesDup++;
  if (!r.parseOk) cyclesBadParse++;
  if (r.ids.includes(999999)) cyclesDup++; // a dropped-during-shutdown event leaked to disk
}

console.log(JSON.stringify({
  probe: 'rv5-coalesce-trailing', cycles: CYCLES,
  cyclesWithLostTrailingWrite: cyclesLost,
  cyclesWithDuplication: cyclesDup,
  cyclesWithCorruptFile: cyclesBadParse,
  worstShutdownMs: Math.round(worstDeadlockMs),
  unhandledRejections: unhandled,
  ASSERT_noLoss: cyclesLost === 0,
  ASSERT_noDup: cyclesDup === 0,
  ASSERT_noCorruption: cyclesBadParse === 0,
  ASSERT_noHang: worstDeadlockMs < 3000,
}));
process.exit(0);
