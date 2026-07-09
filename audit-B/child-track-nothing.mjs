// Child: init + a few track(), then do NOTHING. Must exit on its own (no shutdown()).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';
const qd = mkdtempSync(join(tmpdir(), 'muon-cn-'));
muon.init('c', 'http://127.0.0.1:9', { queueDir: qd });
muon.track('a', { x: 1 });
muon.track('b', { y: 2 });
// no shutdown, no flush — timers must be unref'd so the process exits.
