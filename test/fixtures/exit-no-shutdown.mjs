// Killer fixture: init + track, NO shutdown(). The process must exit on its
// own — the SDK may never keep it alive. argv: <port> <queueDir>
import { init, track } from '../../dist/index.js';

const [, , port, queueDir] = process.argv;
init('proj-exit', `http://127.0.0.1:${port}`, { queueDir, requestTimeout: 1_000 });
for (let i = 0; i < 5; i++) track(`exit-${i}`, { i });
console.log('TRACKED');
// end of script — beforeExit gets one bounded flush, then the process exits
