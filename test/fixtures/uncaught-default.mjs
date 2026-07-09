// With NO host handler, Node's default crash behavior (print + exit 1) must
// be preserved — the SDK only records, never swallows. argv: <queueDir>
import { init } from '../../dist/index.js';

init('proj-crash', 'http://127.0.0.1:1', { queueDir: process.argv[2], captureErrors: true });
setTimeout(() => {
  throw new Error('default kaboom');
}, 10);
