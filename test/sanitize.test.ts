/** Contract rows: Input hardening (sanitization layer). */

import { describe, expect, it } from 'vitest';
import {
  distillError,
  MAX_ARRAY_ITEMS,
  MAX_DEPTH,
  MAX_OBJECT_KEYS,
  MAX_STRING_LENGTH,
  sanitizeEventName,
  sanitizeProperties,
  sanitizeShortString,
  sanitizeString,
} from '../src/event.js';

describe('NaN / ±Infinity', () => {
  it('nulls non-finite numbers without throwing', () => {
    const out = sanitizeProperties({ a: NaN, b: Infinity, c: -Infinity, d: 1.5 });
    expect(out).toEqual({ a: null, b: null, c: null, d: 1.5 });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('handles non-finite numbers nested in arrays', () => {
    const out = sanitizeProperties({ xs: [1, NaN, 2, Infinity] });
    expect(out).toEqual({ xs: [1, null, 2, null] });
  });
});

describe('huge payloads', () => {
  it('truncates a 1MB string property', () => {
    const big = 'x'.repeat(1024 * 1024);
    const out = sanitizeProperties({ big });
    expect((out!.big as string).length).toBe(MAX_STRING_LENGTH);
  });

  it('caps a 10k-key object', () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 10_000; i++) obj[`k${i}`] = i;
    const out = sanitizeProperties(obj);
    expect(Object.keys(out!).length).toBe(MAX_OBJECT_KEYS);
  });

  it('caps 100-deep nesting without stack overflow', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 100; i++) deep = { child: deep };
    const out = sanitizeProperties(deep);
    expect(out).toBeDefined();
    // walk down: depth must be bounded
    let cursor: unknown = out;
    let depth = 0;
    while (cursor !== null && typeof cursor === 'object' && 'child' in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>).child;
      depth += 1;
    }
    expect(depth).toBeLessThanOrEqual(MAX_DEPTH);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('caps huge arrays', () => {
    const out = sanitizeProperties({ xs: Array.from({ length: 100_000 }, (_, i) => i) });
    expect((out!.xs as unknown[]).length).toBe(MAX_ARRAY_ITEMS);
  });

  it('enforces a total node budget on wide+deep payloads', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 400; i++) {
      const inner: Record<string, number> = {};
      for (let j = 0; j < 400; j++) inner[`j${j}`] = j;
      wide[`i${i}`] = inner;
    }
    const out = sanitizeProperties(wide);
    expect(out).toBeDefined();
    expect(JSON.stringify(out).length).toBeLessThan(2_000_000); // bounded, no OOM
  });
});

describe('circular references', () => {
  it('drops a self-referencing object without looping', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(sanitizeProperties(a)).toEqual({ name: 'a' });
  });

  it('drops mutual cycles', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { a };
    a.b = b;
    const out = sanitizeProperties({ a });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('drops circular arrays', () => {
    const xs: unknown[] = [1, 2];
    xs.push(xs);
    expect(sanitizeProperties({ xs })).toEqual({ xs: [1, 2] });
  });

  it('keeps the same object referenced from sibling branches (DAG, not a cycle)', () => {
    const shared = { v: 1 };
    expect(sanitizeProperties({ a: shared, b: shared })).toEqual({ a: { v: 1 }, b: { v: 1 } });
  });
});

describe('non-serializable values', () => {
  it('drops functions, symbols and undefined', () => {
    const out = sanitizeProperties({ f: () => 1, s: Symbol('x'), u: undefined, keep: 1 });
    expect(out).toEqual({ keep: 1 });
  });

  it('converts safe BigInt to number, huge BigInt to string', () => {
    const out = sanitizeProperties({ small: 42n, huge: 2n ** 80n });
    expect(out).toEqual({ small: 42, huge: (2n ** 80n).toString() });
  });

  it('converts Date to ISO-8601 and invalid Date to null', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    const out = sanitizeProperties({ d, bad: new Date('garbage') });
    expect(out).toEqual({ d: '2026-01-02T03:04:05.000Z', bad: null });
  });

  it('drops byte buffers and typed arrays', () => {
    const out = sanitizeProperties({
      buf: Buffer.from('abc'),
      u8: new Uint8Array([1, 2]),
      ab: new ArrayBuffer(8),
      keep: true,
    });
    expect(out).toEqual({ keep: true });
  });

  it('drops Map/Set/WeakMap/WeakSet', () => {
    const out = sanitizeProperties({ m: new Map([['a', 1]]), s: new Set([1]), wm: new WeakMap(), ws: new WeakSet(), keep: 0 });
    expect(out).toEqual({ keep: 0 });
  });

  it('walks custom class instances via own enumerable properties', () => {
    class Plan {
      name = 'pro';
      seats = 5;
      #secret = 'hidden';
      describe() {
        return this.#secret;
      }
    }
    expect(sanitizeProperties({ plan: new Plan() })).toEqual({ plan: { name: 'pro', seats: 5 } });
  });

  it('honors toJSON()', () => {
    const custom = { toJSON: () => ({ v: 7 }) };
    expect(sanitizeProperties({ custom })).toEqual({ custom: { v: 7 } });
  });

  it('drops values whose toJSON throws', () => {
    const bad = {
      toJSON() {
        throw new Error('nope');
      },
    };
    expect(sanitizeProperties({ bad, keep: 1 })).toEqual({ keep: 1 });
  });

  it('skips throwing getters and keeps the rest', () => {
    const obj = { keep: 1 };
    Object.defineProperty(obj, 'boom', {
      enumerable: true,
      get() {
        throw new Error('hostile getter');
      },
    });
    expect(sanitizeProperties(obj)).toEqual({ keep: 1 });
  });

  it('drops non-object properties payloads entirely', () => {
    expect(sanitizeProperties('str')).toBeUndefined();
    expect(sanitizeProperties(42)).toBeUndefined();
    expect(sanitizeProperties([1, 2, 3])).toBeUndefined();
    expect(sanitizeProperties(new Date())).toBeUndefined();
    expect(sanitizeProperties(Buffer.from('x'))).toBeUndefined();
    expect(sanitizeProperties(null)).toBeUndefined();
    expect(sanitizeProperties(undefined)).toBeUndefined();
  });
});

describe('event names and reserved keys', () => {
  it('rejects empty and whitespace-only names', () => {
    expect(sanitizeEventName('')).toBeUndefined();
    expect(sanitizeEventName('   ')).toBeUndefined();
    expect(sanitizeEventName('\t\n')).toBeUndefined();
    expect(sanitizeEventName('\u0000')).toBeUndefined();
  });

  it('rejects non-string names but coerces finite numbers', () => {
    expect(sanitizeEventName(null)).toBeUndefined();
    expect(sanitizeEventName({})).toBeUndefined();
    expect(sanitizeEventName(NaN)).toBeUndefined();
    expect(sanitizeEventName(42)).toBe('42');
    expect(sanitizeEventName(' signup ')).toBe('signup');
  });

  it('truncates very long names', () => {
    expect(sanitizeEventName('n'.repeat(10_000))!.length).toBeLessThanOrEqual(256);
  });

  it('strips reserved keys (__proto__, constructor, prototype) from properties', () => {
    const raw = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "prototype": 2, "ok": 3}');
    const out = sanitizeProperties(raw)!;
    expect(out).toEqual({ ok: 3 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // no pollution
  });

  it('trims keys and drops empty keys', () => {
    const out = sanitizeProperties({ '  padded  ': 1, '   ': 2, '': 3 });
    expect(out).toEqual({ padded: 1 });
  });
});

describe('unicode', () => {
  it('keeps emoji and RTL text intact', () => {
    const out = sanitizeProperties({ emoji: '🚀🔥', rtl: 'مرحبا بالعالم', mixed: 'a→ب→🚀' });
    expect(out).toEqual({ emoji: '🚀🔥', rtl: 'مرحبا بالعالم', mixed: 'a→ب→🚀' });
  });

  it('replaces lone surrogates so JSON stays well-formed', () => {
    const out = sanitizeProperties({ bad: 'a\uD800b', alsoBad: '\uDC00' })!;
    const encoded = JSON.stringify(out);
    expect(encoded).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out.bad).toBe('a�b');
  });

  it('does not split surrogate pairs when truncating', () => {
    const s = '🚀'.repeat(MAX_STRING_LENGTH); // each rocket is 2 code units
    const out = sanitizeString(s);
    expect(out.length).toBeLessThanOrEqual(MAX_STRING_LENGTH);
    expect(() => encodeURIComponent(out)).not.toThrow(); // throws on lone surrogates
  });

  it('strips NUL bytes', () => {
    expect(sanitizeProperties({ s: 'a\u0000b' })).toEqual({ s: 'ab' });
    expect(sanitizeEventName('na\u0000me')).toBe('name');
  });
});

describe('short string fields', () => {
  it('coerces finite numbers and rejects everything else non-string', () => {
    expect(sanitizeShortString(123)).toBe('123');
    expect(sanitizeShortString(NaN)).toBeUndefined();
    expect(sanitizeShortString({})).toBeUndefined();
    expect(sanitizeShortString('')).toBeUndefined();
    expect(sanitizeShortString('/pricing')).toBe('/pricing');
  });
});

describe('distillError', () => {
  it('extracts name + message from an Error', () => {
    expect(distillError(new TypeError('bad thing'))).toEqual({ name: 'TypeError', message: 'bad thing' });
  });

  it('handles strings, numbers, null, undefined, objects and symbols', () => {
    expect(distillError('plain failure')).toEqual({ name: 'Error', message: 'plain failure' });
    expect(distillError(42)).toEqual({ name: 'Error', message: '42' });
    expect(distillError(null)).toEqual({ name: 'Error', message: 'null' });
    expect(distillError(undefined)).toEqual({ name: 'Error', message: 'undefined' });
    expect(distillError(Symbol('boom')).name).toBe('Error');
    const custom = { name: 'DbError', message: 'conn lost' };
    expect(distillError(custom)).toEqual({ name: 'DbError', message: 'conn lost' });
  });

  it('never throws, even for hostile objects', () => {
    const hostile = {
      get name(): string {
        throw new Error('gotcha');
      },
      toString(): string {
        throw new Error('gotcha');
      },
    };
    const out = distillError(hostile);
    expect(typeof out.name).toBe('string');
    expect(typeof out.message).toBe('string');
  });

  it('truncates gigantic messages', () => {
    const out = distillError(new Error('m'.repeat(1_000_000)));
    expect(out.message.length).toBeLessThanOrEqual(2_048);
  });
});
