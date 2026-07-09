// P2: spawn each child; each MUST exit on its own within HARD_LIMIT ms.
// A child that must be killed = hang = critical finding.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARD_LIMIT = 8000;

function runChild(script) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [join(__dirname, script)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', killed = false;
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => { killed = true; p.kill('SIGKILL'); }, HARD_LIMIT);
    p.on('exit', (code, sig) => {
      clearTimeout(timer);
      resolve({ script, exitMs: Date.now() - t0, code, sig, killed,
        stdout: out.trim().split('\n').slice(-3).join(' | '),
        stderr: err.trim().split('\n').slice(0, 2).join(' | ') });
    });
  });
}

const scripts = [
  'child-track-nothing.mjs',
  'child-dead-port.mjs',
  'child-stall-flush.mjs',
  'child-capture-errors.mjs',
  'child-active-handles.mjs',
];
for (const s of scripts) {
  const r = await runChild(s);
  console.log(JSON.stringify(r));
}
process.exit(0);
