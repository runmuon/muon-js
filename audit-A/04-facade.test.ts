import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as muon from '../src/index.js';
import { installLeakGuard, drainMicrotasks } from './leakguard.js';

const qd = () => mkdtempSync(join(tmpdir(), 'muon-facade-'));
afterEach(async () => { await muon.shutdown(); });

describe('facade — call every method before init()', () => {
  it('no throw, flush resolves', async () => {
    const leaks = installLeakGuard();
    expect(() => muon.track('x', { a: 1 })).not.toThrow();
    expect(() => muon.pageView('/p')).not.toThrow();
    expect(() => muon.identify('u')).not.toThrow();
    expect(() => muon.setRelease('1.0')).not.toThrow();
    expect(() => muon.captureError(new Error('e'))).not.toThrow();
    await expect(muon.flush()).resolves.toBeUndefined();
    await expect(muon.shutdown()).resolves.toBeUndefined();
    await drainMicrotasks();
    expect(leaks.rejections).toEqual([]);
    leaks.stop();
  });
});

describe('facade — hostile init args', () => {
  const bads: [string, unknown, unknown][] = [
    ['javascript host', 'p', 'javascript:alert(1)'],
    ['file host', 'p', 'file:///etc/passwd'],
    ['empty host', 'p', ''],
    ['whitespace host', 'p', '   '],
    ['non-http host', 'p', 'ftp://x'],
    ['object host', 'p', {} as unknown],
    ['null host', 'p', null],
    ['number host', 'p', 42],
    ['empty projectId', '', 'https://muon.run'],
    ['object projectId', {} as unknown, 'https://muon.run'],
    ['null projectId', null, 'https://muon.run'],
    ['number projectId', 42, 'https://muon.run'],
  ];
  for (const [label, pid, host] of bads) {
    it(`init(${label}) is inert, not fatal`, async () => {
      const leaks = installLeakGuard();
      expect(() => muon.init(pid as string, host as string, { queueDir: qd() })).not.toThrow();
      // subsequent calls stay safe
      expect(() => muon.track('x')).not.toThrow();
      await expect(muon.flush()).resolves.toBeUndefined();
      await drainMicrotasks();
      expect(leaks.rejections).toEqual([]);
      expect(leaks.exceptions).toEqual([]);
      leaks.stop();
    });
  }

  it('init with hostile options object (throwing getters)', async () => {
    const leaks = installLeakGuard();
    const opts: any = { queueDir: qd() };
    Object.defineProperty(opts, 'debug', { enumerable: true, get() { throw new Error('debug-getter'); } });
    expect(() => muon.init('p', 'https://muon.run', opts)).not.toThrow();
    // Does the throwing getter brick re-init? Try to recover.
    await muon.shutdown();
    muon.init('p', 'https://muon.run', { queueDir: qd() });
    expect(() => muon.track('x')).not.toThrow();
    await drainMicrotasks();
    expect(leaks.rejections).toEqual([]);
    leaks.stop();
  });

  it('init with options getters that throw on flushAt/maxQueueEvents', async () => {
    const leaks = installLeakGuard();
    const opts: any = { queueDir: qd() };
    Object.defineProperty(opts, 'flushAt', { enumerable: true, get() { throw new Error('x'); } });
    expect(() => muon.init('p', 'https://muon.run', opts)).not.toThrow();
    expect(() => muon.track('x')).not.toThrow();
    await drainMicrotasks();
    expect(leaks.rejections).toEqual([]);
    leaks.stop();
  });
});

describe('facade — lifecycle abuse', () => {
  it('init twice then use', async () => {
    muon.init('p', 'https://muon.run', { queueDir: qd() });
    muon.init('p2', 'https://other.run', { queueDir: qd() });
    expect(() => muon.track('x')).not.toThrow();
    await muon.flush();
  });

  it('init → shutdown → track → init again (re-init) works', async () => {
    const leaks = installLeakGuard();
    muon.init('p', 'https://muon.run', { queueDir: qd(), flushInterval: 60_000 });
    muon.track('a');
    await muon.shutdown();
    // use-after-shutdown
    expect(() => muon.track('after-shutdown')).not.toThrow();
    await expect(muon.flush()).resolves.toBeUndefined();
    // re-init
    muon.init('p', 'https://muon.run', { queueDir: qd(), flushInterval: 60_000 });
    expect(() => muon.track('b')).not.toThrow();
    await drainMicrotasks();
    expect(leaks.rejections).toEqual([]);
    expect(leaks.exceptions).toEqual([]);
    leaks.stop();
  });

  it('flush() 100x concurrently at facade', async () => {
    const leaks = installLeakGuard();
    muon.init('p', 'http://127.0.0.1:1', { queueDir: qd(), flushInterval: 60_000 });
    for (let i = 0; i < 50; i++) muon.track('e' + i);
    await Promise.all(Array.from({ length: 100 }, () => muon.flush()));
    await drainMicrotasks();
    expect(leaks.rejections).toEqual([]);
    leaks.stop();
  });

  it('shutdown 100x concurrently', async () => {
    const leaks = installLeakGuard();
    muon.init('p', 'https://muon.run', { queueDir: qd() });
    muon.track('a');
    await Promise.all(Array.from({ length: 100 }, () => muon.shutdown()));
    await drainMicrotasks();
    expect(leaks.rejections).toEqual([]);
    leaks.stop();
  });

  it('does NOT leak process beforeExit listeners across many init/shutdown cycles', async () => {
    const before = process.listenerCount('beforeExit');
    for (let i = 0; i < 50; i++) {
      muon.init('p', 'https://muon.run', { queueDir: qd(), captureErrors: true });
      muon.track('x');
      await muon.shutdown();
    }
    const after = process.listenerCount('beforeExit');
    console.log('beforeExit listeners before=', before, 'after=', after);
    expect(after - before).toBeLessThanOrEqual(1);
  });
});
