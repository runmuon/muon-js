/** Contract rows: API surface, pre-init safety, double init, malformed host, disabled, debug warn-once. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Muon, { captureError, flush, identify, init, pageView, setRelease, shutdown, track } from '../src/index.js';
import { removeDir, tempDir } from './helpers/env.js';
import { startServer, type FixtureServer } from './helpers/server.js';

let dir: string;
let server: FixtureServer;

beforeEach(async () => {
  dir = await tempDir();
  server = await startServer();
});

afterEach(async () => {
  await shutdown();
  await server.close();
  await removeDir(dir);
  vi.restoreAllMocks();
});

describe('pre-init safety', () => {
  it('track/pageView/identify/setRelease/captureError before init are safe no-ops', async () => {
    expect(() => track('early')).not.toThrow();
    expect(() => pageView('/early')).not.toThrow();
    expect(() => identify('u1')).not.toThrow();
    expect(() => setRelease('1.0.0')).not.toThrow();
    expect(() => captureError(new Error('early'))).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
    await expect(shutdown()).resolves.toBeUndefined();
    expect(server.requests()).toBe(0);
  });
});

describe('init', () => {
  it('delivers events end-to-end after init', async () => {
    init('proj-1', server.url, { queueDir: dir });
    identify('acct_9f4c2a');
    setRelease('web-2026.07.09');
    track('checkout_started', { cartValue: 12800, currency: 'USD' });
    pageView('/pricing', 'Pricing');
    await flush();
    const events = server.allEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ project: 'proj-1', type: 'custom', name: 'checkout_started', distinctId: 'acct_9f4c2a', release: 'web-2026.07.09' });
    expect(events[1]).toMatchObject({ type: 'page_view', url: '/pricing', title: 'Pricing' });
  });

  it('posts to {host}/api/track/batch, preserving a base path', async () => {
    init('proj-1', `${server.url}/sub/dir/`, { queueDir: dir });
    track('e');
    await flush();
    expect(server.batches[0]!.url).toBe('/sub/dir/api/track/batch');
  });

  it('second init() warns once and is ignored', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    init('proj-1', server.url, { queueDir: dir, debug: true });
    init('proj-other', 'http://127.0.0.1:1', { queueDir: dir, debug: true });
    init('proj-other-2', 'http://127.0.0.1:1', { queueDir: dir, debug: true });
    track('after-double-init');
    await flush();
    // first config won: events reach the real server
    expect(server.allEvents().map((e) => e.name)).toEqual(['after-double-init']);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('twice'))).toHaveLength(1);
  });

  it('malformed host URL leaves the SDK inert but safe', async () => {
    for (const bad of ['not a url', 'ftp://x.example', '', '   ', 'http//broken']) {
      init('proj-1', bad as string, { queueDir: dir });
      expect(() => track('x')).not.toThrow();
      await expect(flush()).resolves.toBeUndefined();
      await shutdown();
    }
    // non-string host
    init('proj-1', 12345 as unknown as string, { queueDir: dir });
    expect(() => track('x')).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
    expect(server.requests()).toBe(0);
  });

  it('empty projectId leaves the SDK inert but safe', async () => {
    init('   ', server.url, { queueDir: dir });
    track('x');
    await flush();
    expect(server.requests()).toBe(0);
  });

  it('disabled: true makes every call a no-op', async () => {
    init('proj-1', server.url, { queueDir: dir, disabled: true });
    track('nope');
    pageView('/nope');
    captureError(new Error('nope'));
    await flush();
    await shutdown();
    expect(server.requests()).toBe(0);
  });

  it('nonsense option values fall back to defaults without throwing', async () => {
    init('proj-1', server.url, {
      queueDir: dir,
      flushAt: NaN,
      flushInterval: -5,
      maxQueueEvents: Number.POSITIVE_INFINITY as unknown as number,
      requestTimeout: 'soon' as unknown as number,
    });
    track('still-works');
    await flush();
    expect(server.allEvents()).toHaveLength(1);
  });

  it('null options object is tolerated', async () => {
    init('proj-1', server.url, null as unknown as Record<string, never>);
    expect(() => track('ok')).not.toThrow();
  });
});

describe('quiet failure / debug warnings', () => {
  it('no console output at all without debug', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    init('proj-1', server.url, { queueDir: dir });
    track('' as string); // bad name
    track('' as string);
    track(undefined as unknown as string);
    await flush();
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('with debug: at most one warning per distinct misconfiguration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    init('proj-1', server.url, { queueDir: dir, debug: true });
    track('');
    track('');
    track('   ');
    const nameWarnings = warn.mock.calls.filter(([m]) => String(m).includes('event name'));
    expect(nameWarnings).toHaveLength(1);
  });
});

describe('input abuse through the facade', () => {
  it('hostile arguments to every public call never throw', async () => {
    init('proj-1', server.url, { queueDir: dir });
    const hostile = [null, undefined, 42, NaN, Symbol('x'), () => 1, {}, [], 10n ** 30n];
    for (const v of hostile) {
      expect(() => track(v as never, v as never)).not.toThrow();
      expect(() => pageView(v as never, v as never)).not.toThrow();
      expect(() => identify(v as never)).not.toThrow();
      expect(() => setRelease(v as never)).not.toThrow();
      expect(() => captureError(v, v as never)).not.toThrow();
    }
    await expect(flush()).resolves.toBeUndefined();
  });

  it('identify with a number coerces; identify with garbage is ignored', async () => {
    init('proj-1', server.url, { queueDir: dir });
    identify(777 as unknown as string);
    track('a');
    identify({} as unknown as string); // ignored, keeps previous id
    track('b');
    await flush();
    const events = server.allEvents();
    expect(events[0]!.distinctId).toBe('777');
    expect(events[1]!.distinctId).toBe('777');
  });

  it('error dedupe + rate limit per run', async () => {
    init('proj-1', server.url, { queueDir: dir, maxDuplicateErrors: 2, maxErrorsPerRun: 5 });
    for (let i = 0; i < 10; i++) captureError(new TypeError('same message'));
    for (let i = 0; i < 10; i++) captureError(new RangeError(`different ${i}`));
    await flush();
    const errors = server.allEvents().filter((e) => e.type === 'browser_error');
    expect(errors.filter((e) => e.name === 'TypeError')).toHaveLength(2); // deduped
    expect(errors).toHaveLength(5); // capped per run
  });

  it('default export exposes the same API', () => {
    expect(Muon.init).toBe(init);
    expect(Muon.track).toBe(track);
    expect(Muon.shutdown).toBe(shutdown);
  });
});
