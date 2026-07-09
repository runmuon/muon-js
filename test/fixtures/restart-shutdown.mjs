// Regression (Lens B RV2): after a restart that restores a non-empty queue,
// `await shutdown()` on an idle loop must resolve (not hang on restore()'s
// debounced persist) and must NOT lose the newly-tracked events.
// argv: <dir> <phase A|B>
import { init, track, shutdown } from '/Users/alexdolgov/Projects/my/muon/sdks/js/dist/index.js';
import { readdirSync, readFileSync } from 'node:fs';
const [dir, phase] = process.argv.slice(2);
init('11111111-1111-1111-1111-111111111111', 'http://127.0.0.1:59999', { queueDir: dir });
if (phase === 'A') { for (let i = 0; i < 10; i++) track('a' + i); }
else { for (let i = 0; i < 5; i++) track('b' + i); }
const t = Date.now();
await shutdown();
const q = readdirSync(dir).find((f) => f.includes('queue'));
const lines = q ? readFileSync(dir + '/' + q, 'utf8').trim().split('\n').length : 0;
console.log(JSON.stringify({ phase, ms: Date.now() - t, lines }));
