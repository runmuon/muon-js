// captureErrors:true + a pre-existing uncaughtException handler.
// Expected per contract rule 6: host handler still fires; muon monitor persists
// crash; muon never exits for the host.
import { readFileSync, readdirSync } from 'node:fs';
import * as muon from '../dist/index.js';

const qdir = process.env.QDIR;
let hostHandlerFired = false;
process.on('uncaughtException', (e) => {
  hostHandlerFired = true;
  // report what we observed, then exit deliberately (host's choice)
  const files = readdirSync(qdir);
  const crashFile = files.find((f) => f.endsWith('.crash.jsonl'));
  const persisted = crashFile ? readFileSync(qdir + '/' + crashFile, 'utf8').trim() : '';
  console.log(JSON.stringify({ hostHandlerFired, msg: e.message, crashPersisted: persisted.length > 0, crash: persisted }));
  process.exit(0);
});

muon.init('p', 'https://muon.run', { queueDir: qdir, captureErrors: true });
// throw async so init settles
setTimeout(() => { throw new Error('BOOM-uncaught'); }, 50);
