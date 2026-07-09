// Child: after shutdown(), report any active handles/requests still holding
// the loop open. Ideal = none attributable to the SDK.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';
const qd = mkdtempSync(join(tmpdir(), 'muon-ah-'));
muon.init('c', 'http://127.0.0.1:9', { queueDir: qd });
for (let i = 0; i < 30; i++) muon.track('e', { i });
await muon.flush();
await muon.shutdown();
const res = process.getActiveResourcesInfo();
// filter out the always-present ones
const interesting = res.filter((r) => !['TTYWrap', 'ProcessWrap', 'PipeWrap', 'Immediate', 'TickObject'].includes(r));
console.log('activeResources=', JSON.stringify(res));
console.log('handles=', process._getActiveHandles().map((h) => h.constructor?.name));
console.log('requests=', process._getActiveRequests().map((h) => h.constructor?.name));
console.log('interestingCount=', interesting.length);
