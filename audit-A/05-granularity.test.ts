import { describe, it, expect } from 'vitest';
import { sanitizeProperties } from '../src/event.js';

describe('sanitize granularity: does one hostile nested value nuke the whole payload?', () => {
  it('throwing GETTER on a sibling key: only that key is dropped (good granularity)', () => {
    const o: any = { good: 1, keepme: 'yes' };
    Object.defineProperty(o, 'bad', { enumerable: true, get() { throw new Error('x'); } });
    const out = sanitizeProperties(o);
    console.log('getter-sibling:', JSON.stringify(out));
    expect(out).toEqual({ good: 1, keepme: 'yes' });
  });

  it('nested Proxy whose get-trap throws: ENTIRE payload dropped (poor granularity)', () => {
    const p = new Proxy({}, { get() { throw new Error('proxy'); }, ownKeys() { return []; }, getOwnPropertyDescriptor() { return undefined; } });
    const o = { good: 1, keepme: 'yes', bad: p };
    const out = sanitizeProperties(o);
    console.log('proxy-sibling:', JSON.stringify(out));
    // Observed: whole object -> undefined, losing `good`/`keepme` too.
  });

  it('nested Proxy whose getPrototypeOf throws (instanceof): whole payload dropped', () => {
    const p = new Proxy({}, { getPrototypeOf() { throw new Error('proto'); } });
    const o = { good: 1, bad: p };
    const out = sanitizeProperties(o);
    console.log('proto-sibling:', JSON.stringify(out));
  });
});
