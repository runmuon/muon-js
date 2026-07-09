/** Contract rows: Queue & storage. */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MuonCore } from '../src/core.js';
import { defaultQueueDir, QueueStore } from '../src/queue.js';
import { coreConfig, removeDir, tempDir } from './helpers/env.js';
import { startServer, type FixtureServer } from './helpers/server.js';

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
  try {
    await chmod(dir, 0o755); // undo read-only experiments so cleanup works
  } catch {
    // dir may be gone
  }
  await Promise.all(cores.splice(0).map((c) => c.shutdown()));
  await server.close();
  await removeDir(dir);
});

describe('default directory resolution', () => {
  it('uses MUON_QUEUE_DIR when set, else ~/.muon', () => {
    const prev = process.env.MUON_QUEUE_DIR;
    try {
      process.env.MUON_QUEUE_DIR = '/custom/queue/dir';
      expect(defaultQueueDir()).toBe('/custom/queue/dir');
      delete process.env.MUON_QUEUE_DIR;
      expect(defaultQueueDir()).toMatch(/\.muon$/);
    } finally {
      if (prev === undefined) delete process.env.MUON_QUEUE_DIR;
      else process.env.MUON_QUEUE_DIR = prev;
    }
  });
});

describe('restart persistence', () => {
  it('events written by one core are flushed by the next ("restart")', async () => {
    const first = makeCore();
    first.track('survives-1');
    first.track('survives-2');
    await first.settled();
    await first.shutdown(); // server is up, so shutdown flushes — verify delivery
    expect(server.allEvents().map((e) => e.name)).toEqual(['survives-1', 'survives-2']);
  });

  it('events stranded by a dead server survive a restart and flush later', async () => {
    server.setMode(500); // delivery impossible — events must persist
    const first = makeCore();
    first.track('stranded-1');
    first.track('stranded-2');
    await first.flush(); // fails, re-queues, persists
    await first.settled();
    // do NOT shutdown cleanly — simulate an abrupt restart by abandoning `first`
    const raw = await readFile(join(dir, 'proj-1.queue.jsonl'), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);

    server.setMode('ok');
    const second = makeCore();
    await second.settled();
    await second.flush();
    const names = server.allEvents().map((e) => e.name);
    expect(names).toContain('stranded-1');
    expect(names).toContain('stranded-2');
    await first.shutdown();
  });
});

describe('corrupt queue file', () => {
  const variants: Array<[string, string | Buffer]> = [
    ['truncated JSON', '{"project":"p","type":"custom","na'],
    ['garbage bytes', Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01])],
    ['wrong schema (valid JSON, not an event)', JSON.stringify({ hello: 'world' }) + '\n' + JSON.stringify([1, 2, 3])],
    ['empty file', ''],
    ['whitespace only', '\n\n   \n'],
  ];

  it.each(variants)('%s → resets to empty, no throw', async (_label, content) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'proj-1.queue.jsonl'), content);
    const core = makeCore();
    await core.settled();
    expect(core.bufferedCount()).toBe(0);
    core.track('after-corruption');
    await core.flush();
    expect(server.allEvents().map((e) => e.name)).toEqual(['after-corruption']);
  });

  it('keeps valid lines that precede a corrupt tail (torn write)', async () => {
    await mkdir(dir, { recursive: true });
    const good = JSON.stringify({ project: 'proj-1', type: 'custom', name: 'good' });
    await writeFile(join(dir, 'proj-1.queue.jsonl'), `${good}\n{"project":"p","ty`);
    const core = makeCore();
    await core.settled();
    expect(core.bufferedCount()).toBe(1);
    await core.flush();
    expect(server.allEvents().map((e) => e.name)).toEqual(['good']);
  });

  it('corrupt crash file degrades to empty as well', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'proj-1.crash.jsonl'), 'not json at all\n\x00\x01');
    const core = makeCore();
    await core.settled();
    expect(core.bufferedCount()).toBe(0);
  });
});

describe('unwritable storage', () => {
  it.skipIf(process.getuid?.() === 0)('read-only dir degrades to memory-only; events still deliver', async () => {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o555);
    const core = makeCore();
    core.track('memory-only-1');
    core.track('memory-only-2');
    await core.settled(); // all persistence attempts settled — none threw
    await core.flush();
    expect(server.allEvents().map((e) => e.name)).toEqual(['memory-only-1', 'memory-only-2']);
  });

  it.skipIf(process.getuid?.() === 0)('appendCrashSync into a read-only dir does not throw', async () => {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o555);
    const store = new QueueStore(dir, 'proj-1');
    expect(() => store.appendCrashSync({ project: 'p', type: 'browser_error', name: 'E', message: 'm' })).not.toThrow();
  });

  it('a completely bogus directory path degrades silently', async () => {
    let degraded = 0;
    const store = new QueueStore('/dev/null/not-a-dir/really', 'x', () => {
      degraded += 1;
    });
    await store.persist([{ project: 'p', type: 'custom', name: 'a' }]);
    expect(store.memoryOnly).toBe(true);
    expect(degraded).toBe(1);
    // subsequent persists are cheap no-ops, still never throw
    await store.persist([]);
    expect(await store.load()).toEqual([]);
  });
});

describe('queue cap', () => {
  it('overflow drops the oldest — count verified exact', async () => {
    server.setMode(500); // prevent any flush from draining the buffer
    const core = makeCore({ maxQueueEvents: 100, flushAt: 10_000 });
    for (let i = 0; i < 150; i++) core.track(`e-${i}`);
    expect(core.bufferedCount()).toBe(100);
    await core.settled();
    // exact contents: e-50 … e-149 survive, in order
    const raw = await readFile(join(dir, 'proj-1.queue.jsonl'), 'utf8');
    const names = raw
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { name: string }).name);
    expect(names).toHaveLength(100);
    expect(names[0]).toBe('e-50');
    expect(names[99]).toBe('e-149');
  });

  it('the persisted backlog is also trimmed to the cap on restore', async () => {
    server.setMode(500);
    const first = makeCore({ maxQueueEvents: 1_000, flushAt: 10_000 });
    for (let i = 0; i < 500; i++) first.track(`old-${i}`);
    await first.settled();
    const second = makeCore({ maxQueueEvents: 100, flushAt: 10_000 });
    await second.settled();
    expect(second.bufferedCount()).toBe(100);
  });
});

describe('persist coalescing', () => {
  it('rapid persists coalesce into a consistent final file', async () => {
    const store = new QueueStore(dir, 'coalesce');
    const events = Array.from({ length: 50 }, (_, i) => ({ project: 'p', type: 'custom', name: `n-${i}` }));
    for (let i = 1; i <= 50; i++) void store.persist(events.slice(0, i));
    await store.settle();
    const loaded = await store.load();
    expect(loaded).toHaveLength(50);
    expect(loaded[49]!.name).toBe('n-49');
  });

  it('persisting an empty queue removes the file', async () => {
    const store = new QueueStore(dir, 'cleanup');
    await store.persist([{ project: 'p', type: 'custom', name: 'x' }]);
    expect(await store.load()).toHaveLength(1);
    await store.persist([]);
    expect(await store.load()).toEqual([]);
  });
});
