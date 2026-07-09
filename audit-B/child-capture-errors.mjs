// Child: captureErrors:true, then throw an uncaught exception.
// The SDK's uncaughtExceptionMonitor must NOT swallow it: process must still
// crash with non-zero exit (Node default), and must not hang.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';
const qd = mkdtempSync(join(tmpdir(), 'muon-ce-'));
muon.init('c', 'http://127.0.0.1:9', { queueDir: qd, captureErrors: true });
muon.track('e', { x: 1 });
setImmediate(() => { throw new Error('boom-from-host'); });
