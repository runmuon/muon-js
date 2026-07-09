// Regression (Lens B RV NEW-1): `await shutdown()` as the LAST loop activity on
// an otherwise-idle event loop must resolve (not hang on the unref'd debounce)
// AND persist the buffered events. Prints a JSON result line; must exit 0.
import { init, track, shutdown } from '/Users/alexdolgov/Projects/my/muon/sdks/js/dist/index.js';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const dir = mkdtempSync(tmpdir() + '/muon-idle-');
init('11111111-1111-1111-1111-111111111111', 'http://127.0.0.1:59999', { queueDir: dir });
for (let i = 0; i < 5; i++) track('e' + i);
const t = Date.now();
await shutdown();
const q = readdirSync(dir).find((f) => f.includes('queue'));
const lines = q ? readFileSync(dir + '/' + q, 'utf8').trim().split('\n').length : 0;
console.log(JSON.stringify({ ms: Date.now() - t, lines }));
