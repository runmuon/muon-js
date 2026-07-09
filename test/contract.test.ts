/** Contract rows: conformance vs event-contract.md — golden fixture, gzip, batch splitting, distilled errors. */

import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MuonCore } from '../src/core.js';
import { coreConfig, removeDir, tempDir } from './helpers/env.js';
import { startServer, type FixtureServer } from './helpers/server.js';

let dir: string;
let server: FixtureServer;
const cores: MuonCore[] = [];

function makeCore(overrides = {}): MuonCore {
  const core = new MuonCore(
    coreConfig(dir, `${server.url}/api/track/batch`, {
      hostname: 'app.example.com',
      language: 'en-US',
      release: 'web-2026.07.09',
      ...overrides,
    }),
  );
  cores.push(core);
  return core;
}

beforeEach(async () => {
  dir = await tempDir();
  server = await startServer();
});

afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.shutdown()));
  await server.close();
  await removeDir(dir);
});

describe('golden fixture: exact batch body', () => {
  it('custom event matches the contract shape exactly (field names, types, no extras)', async () => {
    const core = makeCore();
    core.identify('acct_9f4c2a');
    core.track('checkout_started', { cartValue: 12800, currency: 'USD' });
    await core.flush();

    const batch = server.batches[0]!;
    // exact envelope: {"events":[…]} and nothing else
    expect(batch.bodyKeys).toEqual(['events']);
    // exact event: strict deep equality — extra/renamed fields fail this
    expect(batch.events).toEqual([
      {
        project: 'proj-1',
        type: 'custom',
        name: 'checkout_started',
        hostname: 'app.example.com',
        language: 'en-US',
        release: 'web-2026.07.09',
        distinctId: 'acct_9f4c2a',
        properties: { cartValue: 12800, currency: 'USD' },
      },
    ]);
  });

  it('page_view event matches the contract shape exactly', async () => {
    const core = makeCore();
    core.pageView('/pricing', 'Pricing');
    await core.flush();
    expect(server.allEvents()).toEqual([
      {
        project: 'proj-1',
        type: 'page_view',
        url: '/pricing',
        title: 'Pricing',
        hostname: 'app.example.com',
        language: 'en-US',
        release: 'web-2026.07.09',
      },
    ]);
  });

  it('pageView normalizes a bare path but keeps absolute URLs', async () => {
    const core = makeCore();
    core.pageView('pricing');
    core.pageView('https://app.example.com/checkout');
    await core.flush();
    const urls = server.allEvents().map((e) => e.url);
    expect(urls).toEqual(['/pricing', 'https://app.example.com/checkout']);
  });

  it('browser_error carries name + message (+page) and NEVER a stack', async () => {
    const core = makeCore();
    core.captureError(new TypeError("Cannot read properties of undefined (reading 'x')"), '/signup');
    await core.flush();
    const [ev] = server.allEvents();
    expect(ev).toEqual({
      project: 'proj-1',
      type: 'browser_error',
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'x')",
      page: '/signup',
      hostname: 'app.example.com',
      language: 'en-US',
      release: 'web-2026.07.09',
    });
    expect(JSON.stringify(server.batches[0]!.events)).not.toContain('stack');
    expect(JSON.stringify(server.batches[0]!.events)).not.toContain('at ');
  });
});

describe('gzip encoding', () => {
  it('the batch body is gzip with correct headers, decompressing to the JSON', async () => {
    const core = makeCore();
    core.track('gz', { n: 1 });
    await core.flush();
    const batch = server.batches[0]!;
    expect(batch.headers['content-encoding']).toBe('gzip');
    expect(batch.headers['content-type']).toBe('application/json');
    // raw bytes really are gzip (magic number) and decode to our JSON
    expect(batch.raw[0]).toBe(0x1f);
    expect(batch.raw[1]).toBe(0x8b);
    const decoded = JSON.parse(gunzipSync(batch.raw).toString('utf8')) as { events: unknown[] };
    expect(decoded.events).toHaveLength(1);
  });
});

describe('batch splitting', () => {
  it('>1000 events split into multiple requests of at most 1000', async () => {
    const core = makeCore({ maxQueueEvents: 10_000, flushAt: 100_000 });
    for (let i = 0; i < 2500; i++) core.track(`bulk-${i}`);
    await core.flush();
    const sizes = server.batches.map((b) => b.events.length);
    expect(sizes).toEqual([1000, 1000, 500]);
    // order preserved end-to-end
    const names = server.allEvents().map((e) => e.name);
    expect(names[0]).toBe('bulk-0');
    expect(names[2499]).toBe('bulk-2499');
  });
});
