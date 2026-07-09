/** Contract rows: Network faults. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MuonCore } from '../src/core.js';
import { backoffDelay, BACKOFF_CAP_MS, Transport } from '../src/transport.js';
import { coreConfig, removeDir, tempDir } from './helpers/env.js';
import { refusedPort, startServer, type FixtureServer } from './helpers/server.js';

let dir: string;
const cores: MuonCore[] = [];
const servers: FixtureServer[] = [];

function makeCore(batchUrl: string, overrides = {}): MuonCore {
  const core = new MuonCore(coreConfig(dir, batchUrl, overrides));
  cores.push(core);
  return core;
}

async function makeServer(mode?: Parameters<typeof startServer>[0]): Promise<FixtureServer> {
  const s = await startServer(mode);
  servers.push(s);
  return s;
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(async () => {
  dir = await tempDir();
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.shutdown()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await removeDir(dir);
  await new Promise((r) => setImmediate(r));
  process.removeListener('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]); // the SDK never leaks a rejection
});

describe('unreachable server', () => {
  it('connection refused: events re-queued, flush resolves, nothing thrown', async () => {
    const port = await refusedPort();
    const core = makeCore(`http://127.0.0.1:${port}/api/track/batch`);
    core.track('will-requeue');
    await expect(core.flush()).resolves.toBeUndefined();
    expect(core.bufferedCount()).toBe(1); // re-queued, not lost
  });

  it('DNS failure: events re-queued, flush resolves', async () => {
    const core = makeCore('http://muon-does-not-exist.invalid/api/track/batch');
    core.track('dns-fail');
    await expect(core.flush()).resolves.toBeUndefined();
    expect(core.bufferedCount()).toBe(1);
  });
});

describe('timeout', () => {
  it('a stalling server is aborted at requestTimeout and events re-queue', async () => {
    const server = await makeServer('stall');
    const core = makeCore(`${server.url}/api/track/batch`, { requestTimeoutMs: 400 });
    core.track('stalled');
    const t0 = Date.now();
    await core.flush();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(5_000); // aborted, not hung
    expect(core.bufferedCount()).toBe(1);
  });
});

describe('retry with capped backoff', () => {
  it('429 and 500 map to retry', async () => {
    for (const status of [429, 500, 502, 503] as const) {
      const server = await makeServer(status);
      const t = new Transport(`${server.url}/api/track/batch`, 2_000);
      const res = await t.send([{ project: 'p', type: 'custom', name: 'x' }]);
      expect(res.outcome).toBe('retry');
      expect(res.status).toBe(status);
    }
  });

  it('backoff grows exponentially and is capped (with jitter bounds)', () => {
    const noJitter = (): number => 0;
    const fullJitter = (): number => 1;
    expect(backoffDelay(1, noJitter)).toBe(500);
    expect(backoffDelay(2, noJitter)).toBe(1_000);
    expect(backoffDelay(3, noJitter)).toBe(2_000);
    // cap: from attempt 6 on, the delay never exceeds BACKOFF_CAP_MS
    for (const attempt of [6, 7, 10, 100, 1_000_000]) {
      expect(backoffDelay(attempt, fullJitter)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
      expect(backoffDelay(attempt, noJitter)).toBeGreaterThanOrEqual(BACKOFF_CAP_MS / 2);
    }
    // jitter is randomized within [exp/2, exp]
    const d = backoffDelay(8);
    expect(d).toBeGreaterThanOrEqual(BACKOFF_CAP_MS / 2);
    expect(d).toBeLessThanOrEqual(BACKOFF_CAP_MS);
  });

  it('after a 500, threshold-triggered flushes are suppressed until the backoff window passes', async () => {
    const server = await makeServer(500);
    const core = makeCore(`${server.url}/api/track/batch`, { flushAt: 1 });
    core.track('first'); // triggers a flush that fails
    await core.flush();
    const after = server.requests();
    core.track('second'); // within backoff — must NOT hammer the server
    core.track('third');
    await new Promise((r) => setTimeout(r, 150));
    expect(server.requests()).toBe(after);
    expect(core.bufferedCount()).toBe(3);
  });

  it('recovers and resets backoff once the server heals', async () => {
    const server = await makeServer(500);
    const core = makeCore(`${server.url}/api/track/batch`);
    core.track('one');
    await core.flush();
    expect(core.bufferedCount()).toBe(1);
    server.setMode('ok');
    await core.flush(); // explicit flush is allowed to bypass the backoff gate
    expect(core.bufferedCount()).toBe(0);
    expect(server.okEvents().map((e) => e.name)).toEqual(['one']); // accepted exactly once
  });
});

describe('permanent rejection', () => {
  it.each([400, 401, 403])('%i drops the batch and does not retry', async (status) => {
    const server = await makeServer(status);
    const core = makeCore(`${server.url}/api/track/batch`);
    core.track('rejected');
    await core.flush();
    expect(core.bufferedCount()).toBe(0); // dropped
    const before = server.requests();
    await core.flush();
    expect(server.requests()).toBe(before); // nothing left to retry
  });
});

describe('malformed response body', () => {
  it('200 with a garbage body is success (status decides)', async () => {
    const server = await makeServer('garbage-200');
    const core = makeCore(`${server.url}/api/track/batch`);
    core.track('ok-garbage');
    await core.flush();
    expect(core.bufferedCount()).toBe(0);
  });

  it('200 with an empty body is success', async () => {
    const server = await makeServer('empty-200');
    const core = makeCore(`${server.url}/api/track/batch`);
    core.track('ok-empty');
    await core.flush();
    expect(core.bufferedCount()).toBe(0);
  });

  it('500 with a garbage body is retry — no parse crash either way', async () => {
    const server = await makeServer('garbage-500');
    const core = makeCore(`${server.url}/api/track/batch`);
    core.track('retry-garbage');
    await core.flush();
    expect(core.bufferedCount()).toBe(1);
  });

  it('parses {processed} when the body is well-formed', async () => {
    const server = await makeServer('ok');
    const t = new Transport(`${server.url}/api/track/batch`, 2_000);
    const res = await t.send([
      { project: 'p', type: 'custom', name: 'a' },
      { project: 'p', type: 'custom', name: 'b' },
    ]);
    expect(res).toMatchObject({ outcome: 'ok', status: 200, processed: 2 });
  });
});

describe('in-flight flush racing new events', () => {
  it('events tracked during an in-flight flush are neither lost nor double-sent', async () => {
    const server = await makeServer('ok');
    const core = makeCore(`${server.url}/api/track/batch`);
    for (let i = 0; i < 10; i++) core.track(`pre-${i}`);
    const flushing = core.flush();
    for (let i = 0; i < 10; i++) core.track(`during-${i}`); // arrive mid-flight
    await flushing;
    await core.flush();
    const names = server.allEvents().map((e) => e.name as string);
    expect(names).toHaveLength(20);
    expect(new Set(names).size).toBe(20); // no duplication
  });

  it('two concurrent flush() calls serialize without duplication', async () => {
    const server = await makeServer('ok');
    const core = makeCore(`${server.url}/api/track/batch`);
    for (let i = 0; i < 30; i++) core.track(`e-${i}`);
    await Promise.all([core.flush(), core.flush(), core.flush()]);
    const names = server.allEvents().map((e) => e.name as string);
    expect(names).toHaveLength(30);
    expect(new Set(names).size).toBe(30);
  });
});
