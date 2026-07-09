// Child: start a flush against a server that ACCEPTS then stalls forever.
// The request must be aborted at requestTimeout; the process must self-exit
// (no shutdown). Prints when the flush promise settles.
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../dist/index.js';

const srv = createServer((req, res) => {
  // read the body then never respond (stall)
  req.on('data', () => {});
  req.on('end', () => { /* hold the socket open, never res.end() */ });
});
srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const qd = mkdtempSync(join(tmpdir(), 'muon-sf-'));
  muon.init('c', `http://127.0.0.1:${port}`, { queueDir: qd, flushAt: 1000, requestTimeout: 800 });
  for (let i = 0; i < 5; i++) muon.track('e', { i });
  const t0 = Date.now();
  await muon.flush();
  console.log('flush settled after ms=', Date.now() - t0);
  // Do NOT close the server or shutdown — we want to see if the process can exit
  // on its own. It CANNOT, because the http server handle is ref'd (that's the
  // test's own server, not the SDK). So we unref the server to isolate the SDK.
  srv.unref();
});
