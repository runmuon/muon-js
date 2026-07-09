// captureErrors:true, but the HOST also listens for unhandledRejection.
// Per errors.ts: muon must only observe/report; host stays in charge and the
// process stays alive.
import * as muon from '../dist/index.js';
const qdir = process.env.QDIR;
let hostFired = false;
process.on('unhandledRejection', (r) => { hostFired = true; });
muon.init('p', 'https://muon.run', { queueDir: qdir, captureErrors: true });
setTimeout(() => { Promise.reject(new Error('BOOM-host-owned')); }, 50);
setTimeout(() => { console.log(JSON.stringify({ hostFired, stillAlive: true })); process.exit(0); }, 400);
