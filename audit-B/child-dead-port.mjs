// Child: track against a dead port, call flush(), then nothing. Must self-exit.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';
const qd = mkdtempSync(join(tmpdir(), 'muon-dp-'));
muon.init('c', 'http://127.0.0.1:1', { queueDir: qd, flushAt: 1 });
for (let i = 0; i < 25; i++) muon.track('e', { i });
muon.flush();
// no shutdown; abort timer + interval must be unref'd → exit anyway.
