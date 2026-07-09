// The host's own unhandledRejection handler keeps the process alive; the SDK
// only observes and reports. argv: <queueDir>
import { init } from '../../dist/index.js';

process.on('unhandledRejection', (reason) => {
  console.log(`HOST_REJ:${reason instanceof Error ? reason.message : String(reason)}`);
});

init('proj-crash', 'http://127.0.0.1:1', { queueDir: process.argv[2], captureErrors: true });
Promise.reject(new Error('handled by host'));
setTimeout(() => {
  console.log('STILL_ALIVE');
  process.exit(0);
}, 400);
