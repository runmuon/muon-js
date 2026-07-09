/** Contract rows: concurrent flush + enqueue stress; 1000 track()+flush races. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MuonCore } from '../src/core.js';
import { coreConfig, removeDir, tempDir } from './helpers/env.js';
import { startServer, type FixtureServer } from './helpers/server.js';

let dir: string;
let server: FixtureServer;
const cores: MuonCore[] = [];

beforeEach(async () => {
  dir = await tempDir();
  server = await startServer();
});

afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.shutdown()));
  await server.close();
  await removeDir(dir);
});

describe('concurrent flush + enqueue', () => {
  it('Promise.all of 1000 racing track() and interleaved flush() loses nothing', async () => {
    const core = new MuonCore(coreConfig(dir, `${server.url}/api/track/batch`, { flushAt: 7 }));
    cores.push(core);

    const jobs: Array<Promise<unknown>> = [];
    for (let i = 0; i < 1000; i++) {
      jobs.push(
        (async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 20));
          core.track('race', { idx: i });
        })(),
      );
      if (i % 50 === 0) jobs.push(core.flush());
    }
    await Promise.all(jobs);
    await core.flush();
    await core.flush(); // drain anything re-buffered

    const received = server.allEvents();
    const indices = received.map((e) => (e.properties as { idx: number }).idx);
    const unique = new Set(indices);
    expect(unique.size).toBe(1000); // every event delivered
    expect(received.length).toBe(1000); // and none duplicated on a healthy network
    // wire integrity under race: every event still fully formed
    for (const e of received) {
      expect(e.project).toBe('proj-1');
      expect(e.type).toBe('custom');
      expect(e.name).toBe('race');
    }
  });

  it('stress with an unreliable server stays at-least-once, never loses', async () => {
    const core = new MuonCore(coreConfig(dir, `${server.url}/api/track/batch`, { flushAt: 5 }));
    cores.push(core);
    let calls = 0;
    // flap the server: every 3rd request fails with 500
    const origSetMode = server.setMode;
    const flapper = setInterval(() => {
      calls += 1;
      origSetMode(calls % 3 === 0 ? 500 : 'ok');
    }, 5);

    const jobs: Array<Promise<unknown>> = [];
    for (let i = 0; i < 300; i++) {
      jobs.push(
        (async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 30));
          core.track('flap', { idx: i });
        })(),
      );
    }
    await Promise.all(jobs);
    clearInterval(flapper);
    server.setMode('ok');
    for (let i = 0; i < 5 && core.bufferedCount() > 0; i++) await core.flush();

    const indices = server.okEvents().map((e) => (e.properties as { idx: number }).idx);
    expect(new Set(indices).size).toBe(300); // nothing lost (duplicates allowed: at-least-once)
  });
});
