// captureErrors:true, muon is the ONLY unhandledRejection listener.
// Per errors.ts: muon persists the crash and RE-RAISES on next tick to
// reproduce Node's default crash (never swallow). Expect nonzero exit.
import * as muon from '../dist/index.js';
const qdir = process.env.QDIR;
muon.init('p', 'https://muon.run', { queueDir: qdir, captureErrors: true });
setTimeout(() => {
  Promise.reject(new Error('BOOM-rejection')); // nobody handles it
}, 50);
// keep alive briefly
setTimeout(() => { console.log('SHOULD-NOT-REACH-IF-RERAISED'); }, 500);
