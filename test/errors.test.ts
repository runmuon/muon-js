/** Contract rows: host error hook chaining, crash persistence + next-launch delivery. */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MuonCore } from '../src/core.js';
import { installErrorHooks, uninstallErrorHooks } from '../src/errors.js';
import { QueueStore } from '../src/queue.js';
import { coreConfig, removeDir, tempDir } from './helpers/env.js';
import { startServer, type FixtureServer } from './helpers/server.js';

const execFileAsync = promisify(execFile);
const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function runFixture(name: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [fixture(name), ...args], { timeout: 10_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

let dir: string;
let server: FixtureServer;
const cores: MuonCore[] = [];

function makeCore(overrides = {}): MuonCore {
  const core = new MuonCore(coreConfig(dir, `${server.url}/api/track/batch`, overrides));
  cores.push(core);
  return core;
}

beforeEach(async () => {
  dir = await tempDir();
  server = await startServer();
});

afterEach(async () => {
  uninstallErrorHooks();
  vi.unstubAllGlobals();
  await Promise.all(cores.splice(0).map((c) => c.shutdown()));
  await server.close();
  await removeDir(dir);
});

describe('uncaughtException (via child processes — real crash semantics)', () => {
  it('pre-existing host handler still fires and controls the exit; crash is persisted', async () => {
    const { code, stdout } = await runFixture('uncaught-chained.mjs', [dir]);
    expect(stdout).toContain('HOST_HANDLER:kaboom'); // the host handler ran
    expect(code).toBe(7); // …and ITS exit code won — the SDK never exited for the host
    const crashRaw = await readFile(join(dir, 'proj-crash.crash.jsonl'), 'utf8');
    const crash = JSON.parse(crashRaw.trim()) as Record<string, unknown>;
    expect(crash).toMatchObject({ project: 'proj-crash', type: 'browser_error', name: 'Error', message: 'kaboom' });
    expect(crashRaw).not.toContain('"stack"');
  });

  it('with no host handler, Node default behavior (print + nonzero exit) is preserved', async () => {
    const { code, stderr } = await runFixture('uncaught-default.mjs', [dir]);
    expect(code).not.toBe(0); // NOT swallowed
    expect(stderr).toContain('default kaboom'); // Node still printed the error
    const crashRaw = await readFile(join(dir, 'proj-crash.crash.jsonl'), 'utf8');
    expect(crashRaw).toContain('default kaboom');
  });
});

describe('unhandledRejection (via child processes)', () => {
  it('host rejection handler chains: it fires, the process stays alive, the SDK records', async () => {
    const { code, stdout } = await runFixture('rejection-chained.mjs', [dir]);
    expect(stdout).toContain('HOST_REJ:handled by host'); // host handler still fired
    expect(stdout).toContain('STILL_ALIVE'); // SDK did not crash or exit the host
    expect(code).toBe(0);
    // reported through the normal pipeline → lands in the queue file
    const queueRaw = await readFile(join(dir, 'proj-crash.queue.jsonl'), 'utf8');
    expect(queueRaw).toContain('handled by host');
    expect(queueRaw).toContain('browser_error');
  });

  it('as the SOLE listener the SDK restores Node default: records, then the process dies', async () => {
    const { code, stdout, stderr } = await runFixture('rejection-sole.mjs', [dir]);
    expect(code).not.toBe(0); // rejection was NOT swallowed
    expect(stdout).not.toContain('SHOULD_NOT_SURVIVE');
    expect(stderr).toContain('sole rejection');
    const crashRaw = await readFile(join(dir, 'proj-crash.crash.jsonl'), 'utf8');
    expect(crashRaw).toContain('sole rejection');
  });
});

describe('hook mechanics (in-process)', () => {
  it('uncaughtExceptionMonitor persists synchronously and dedupes the same throwable', async () => {
    const core = makeCore();
    installErrorHooks(core);
    const boom = new Error('monitor boom');
    process.emit('uncaughtExceptionMonitor', boom);
    process.emit('uncaughtExceptionMonitor', boom); // same object → recorded once
    const crashRaw = await readFile(join(dir, 'proj-1.crash.jsonl'), 'utf8');
    expect(crashRaw.trim().split('\n')).toHaveLength(1);
  });

  it('sole-listener rejection path re-raises the original reason asynchronously', async () => {
    const core = makeCore();
    // detach every existing listener (vitest has its own) so ours is the sole one
    const prior = process.listeners('unhandledRejection');
    for (const l of prior) process.removeListener('unhandledRejection', l);
    const reRaise = vi.fn();
    vi.stubGlobal('setImmediate', reRaise);
    try {
      installErrorHooks(core);
      const reason = new Error('sole in-process');
      process.emit('unhandledRejection', reason, Promise.resolve());
      expect(reRaise).toHaveBeenCalledTimes(1); // default crash scheduled…
      const cb = reRaise.mock.calls[0]![0] as () => void;
      expect(() => cb()).toThrow('sole in-process'); // …with the ORIGINAL reason
      const crashRaw = await readFile(join(dir, 'proj-1.crash.jsonl'), 'utf8');
      expect(crashRaw).toContain('sole in-process');
    } finally {
      uninstallErrorHooks();
      for (const l of prior) process.on('unhandledRejection', l);
    }
  });

  it('chained rejection path (host has a handler): host fires, SDK reports via the normal pipeline', async () => {
    const core = makeCore();
    const prior = process.listeners('unhandledRejection');
    for (const l of prior) process.removeListener('unhandledRejection', l);
    let hostSaw: unknown = null;
    const hostHandler = (reason: unknown): void => {
      hostSaw = reason;
    };
    process.on('unhandledRejection', hostHandler);
    try {
      installErrorHooks(core); // two listeners now — chained branch
      const reason = new Error('chained in-process');
      process.emit('unhandledRejection', reason, Promise.resolve());
      expect(hostSaw).toBe(reason); // host handler still fired
      expect(core.bufferedCount()).toBe(1); // SDK reported (async pipeline, not sync crash file)
      await core.flush();
      expect(server.allEvents()[0]).toMatchObject({ type: 'browser_error', name: 'Error', message: 'chained in-process' });
    } finally {
      uninstallErrorHooks();
      process.removeListener('unhandledRejection', hostHandler);
      for (const l of prior) process.on('unhandledRejection', l);
    }
  });

  it('install is idempotent and uninstall removes exactly our listeners', () => {
    const core = makeCore();
    const monitorBefore = process.listenerCount('uncaughtExceptionMonitor');
    const rejBefore = process.listenerCount('unhandledRejection');
    installErrorHooks(core);
    installErrorHooks(core); // second install must be a no-op
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(monitorBefore + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(rejBefore + 1);
    uninstallErrorHooks();
    uninstallErrorHooks(); // double uninstall safe
    expect(process.listenerCount('uncaughtExceptionMonitor')).toBe(monitorBefore);
    expect(process.listenerCount('unhandledRejection')).toBe(rejBefore);
  });

  it('crash records rate-limit within a run (crash loop cannot flood the disk)', async () => {
    const core = makeCore({ maxDuplicateErrors: 3 });
    installErrorHooks(core);
    for (let i = 0; i < 20; i++) {
      process.emit('uncaughtExceptionMonitor', new Error('same crash')); // distinct objects, same fingerprint
    }
    const crashRaw = await readFile(join(dir, 'proj-1.crash.jsonl'), 'utf8');
    expect(crashRaw.trim().split('\n')).toHaveLength(3);
  });
});

describe('next-launch crash delivery', () => {
  it('crashes persisted by a dying run are delivered by the next core and the crash file is cleared', async () => {
    const store = new QueueStore(dir, 'proj-1');
    store.appendCrashSync({ project: 'proj-1', type: 'browser_error', name: 'FatalError', message: 'it died' });

    const core = makeCore();
    await core.settled();
    await core.flush();
    const [ev] = server.allEvents();
    expect(ev).toMatchObject({ type: 'browser_error', name: 'FatalError', message: 'it died' });
    expect(await store.loadCrashes()).toEqual([]); // cleared after being queued
  });
});
