/** Build artifact smoke tests: dual ESM + CJS with types. */

import { createRequire } from 'node:module';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const dist = (f: string): string => fileURLToPath(new URL(`../dist/${f}`, import.meta.url));

describe('dist artifacts (built by pretest)', () => {
  it('ships ESM, CJS and type declarations', async () => {
    await expect(access(dist('index.js'))).resolves.toBeUndefined();
    await expect(access(dist('index.cjs'))).resolves.toBeUndefined();
    await expect(access(dist('index.d.ts'))).resolves.toBeUndefined();
    await expect(access(dist('index.d.cts'))).resolves.toBeUndefined();
  });

  it('CJS build loads via require() and exposes the full API', () => {
    const mod = require(dist('index.cjs')) as Record<string, unknown>;
    for (const fn of ['init', 'track', 'pageView', 'identify', 'setRelease', 'captureError', 'flush', 'shutdown']) {
      expect(typeof mod[fn], fn).toBe('function');
    }
    expect(typeof (mod.default as Record<string, unknown>).track).toBe('function');
  });

  it('ESM build loads via import() and exposes the full API', async () => {
    const mod = (await import(dist('index.js'))) as Record<string, unknown>;
    for (const fn of ['init', 'track', 'pageView', 'identify', 'setRelease', 'captureError', 'flush', 'shutdown']) {
      expect(typeof mod[fn], fn).toBe('function');
    }
  });
});
