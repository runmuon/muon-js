// The host's own uncaughtException handler must keep working (and stay in
// charge of the exit) with captureErrors enabled. argv: <queueDir>
import { init } from '../../dist/index.js';

process.on('uncaughtException', (err) => {
  console.log(`HOST_HANDLER:${err.message}`);
  process.exit(7); // the HOST decides the exit — never the SDK
});

init('proj-crash', 'http://127.0.0.1:1', { queueDir: process.argv[2], captureErrors: true });
setTimeout(() => {
  throw new Error('kaboom');
}, 10);
