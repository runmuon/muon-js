// With NO host rejection handler, subscribing would normally swallow the
// rejection. The SDK must restore Node's default: record, then crash.
// argv: <queueDir>
import { init } from '../../dist/index.js';

init('proj-crash', 'http://127.0.0.1:1', { queueDir: process.argv[2], captureErrors: true });
Promise.reject(new Error('sole rejection'));
setTimeout(() => {
  console.log('SHOULD_NOT_SURVIVE');
  process.exit(0);
}, 1_000);
