/**
 * The canonical Muon event — mirrors `docs/event-contract.md` exactly —
 * plus the input sanitization layer.
 *
 * Sanitization is the SDK's first do-no-harm line: anything the host hands us
 * (NaN, BigInt, circular graphs, megabyte strings, throwing getters, lone
 * surrogates) is reduced to plain, bounded, JSON-safe data here, so nothing
 * downstream (queue file, gzip, wire) can ever throw on bad input.
 */

/** JSON-safe value after sanitization. */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** A single event as sent to `POST /api/track/batch`. */
export interface MuonEvent {
  project: string;
  /** "page_view" | "custom" | "browser_error" */
  type: string;
  name?: string;
  url?: string;
  referrer?: string;
  hostname?: string;
  title?: string;
  screen?: string;
  language?: string;
  release?: string;
  distinctId?: string;
  properties?: JsonObject;
  /** browser_error only */
  message?: string;
  /** browser_error only */
  page?: string;
}

// ---------------------------------------------------------------------------
// Limits (documented in the README)
// ---------------------------------------------------------------------------

/** Max length of a string property value; longer strings are truncated. */
export const MAX_STRING_LENGTH = 16_384;
/** Max length of an object key. */
export const MAX_KEY_LENGTH = 256;
/** Max nesting depth inside `properties`; deeper values are dropped. */
export const MAX_DEPTH = 16;
/** Max keys kept per object. */
export const MAX_OBJECT_KEYS = 512;
/** Max items kept per array. */
export const MAX_ARRAY_ITEMS = 1_024;
/** Total node budget per `properties` payload — hard cap on overall size. */
export const MAX_TOTAL_NODES = 10_000;
/** Max length of an event name. */
export const MAX_NAME_LENGTH = 256;
/** Max length of an error message. */
export const MAX_MESSAGE_LENGTH = 2_048;
/** Max length of url / page / title strings. */
export const MAX_URL_LENGTH = 2_048;

/** Keys that would be dangerous or meaningless to forward. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Lone surrogate halves — invalid UTF-16 that some JSON consumers reject.
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Make a string safe for the wire: bounded length, no NUL bytes, and
 * well-formed UTF-16 (lone surrogates become U+FFFD). Never throws.
 */
export function sanitizeString(value: string, max: number = MAX_STRING_LENGTH): string {
  let s = value.length > max ? value.slice(0, max) : value;
  // Prefer the native well-formed conversion (Node >= 20); fall back to regex.
  const anyStr = s as string & { toWellFormed?: () => string };
  s = typeof anyStr.toWellFormed === 'function' ? anyStr.toWellFormed() : s.replace(LONE_SURROGATES, '�');
  if (s.includes('\u0000')) s = s.split('\u0000').join('');
  return s;
}

/**
 * Sanitize an event name. Returns `undefined` (drop the event) for non-string,
 * empty, or whitespace-only names.
 */
export function sanitizeEventName(name: unknown): string | undefined {
  let v = name;
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return undefined;
  const s = sanitizeString(v.trim(), MAX_NAME_LENGTH).trim();
  return s.length > 0 ? s : undefined;
}

/**
 * Sanitize a short string field (url, title, page, distinctId, release…).
 * Numbers are coerced; anything else non-string is dropped.
 */
export function sanitizeShortString(value: unknown, max: number = MAX_URL_LENGTH): string | undefined {
  let v = value;
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return undefined;
  const s = sanitizeString(v, max);
  return s.trim().length > 0 ? s : undefined;
}

interface Budget {
  nodes: number;
}

function sanitizeKey(key: string): string | undefined {
  const k = sanitizeString(key.trim(), MAX_KEY_LENGTH).trim();
  if (k.length === 0 || RESERVED_KEYS.has(k)) return undefined;
  return k;
}

function isBinary(value: object): boolean {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer);
}

/**
 * Best-effort conversion of an arbitrary value to bounded, JSON-safe data.
 * Returns `undefined` when the value must be dropped. Documented rules:
 *
 * - `NaN` / `±Infinity` → `null`
 * - `BigInt` → number when within safe-integer range, else decimal string
 * - `Date` → ISO-8601 string (invalid dates → `null`)
 * - functions, symbols, `undefined`, byte buffers, `Map`/`Set` → dropped
 * - objects with `toJSON()` → the sanitized `toJSON()` result
 * - other objects (incl. class instances) → own enumerable properties
 * - circular references → dropped at the point of the cycle
 * - strings truncated, objects/arrays/depth/total size capped
 */
function sanitizeValue(value: unknown, depth: number, budget: Budget, seen: Set<object>): JsonValue | undefined {
  if (budget.nodes <= 0) return undefined;
  budget.nodes -= 1;

  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return sanitizeString(value);
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    case 'bigint':
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value)
        : sanitizeString(value.toString());
    case 'object':
      break;
    default:
      // function, symbol, undefined
      return undefined;
  }

  const obj = value as object;
  // Everything from here — including the shape probes themselves (`instanceof`,
  // `toJSON` access) — runs under a guard so ONE hostile value (e.g. a Proxy
  // whose `getPrototypeOf`/`get` trap throws) drops only itself; sibling keys
  // survive. `added` tracks whether we still owe a `seen.delete`.
  let added = false;
  try {
    if (obj instanceof Date) {
      const t = obj.getTime();
      return Number.isFinite(t) ? obj.toISOString() : null;
    }
    if (isBinary(obj) || obj instanceof Map || obj instanceof Set || obj instanceof WeakMap || obj instanceof WeakSet) {
      return undefined;
    }
    if (depth >= MAX_DEPTH) return undefined;
    if (seen.has(obj)) return undefined; // circular reference
    seen.add(obj);
    added = true;
    if (Array.isArray(obj)) {
      const out: JsonValue[] = [];
      for (let i = 0; i < obj.length && out.length < MAX_ARRAY_ITEMS && budget.nodes > 0; i++) {
        let raw: unknown;
        try {
          raw = obj[i];
        } catch {
          continue; // hostile proxy trap
        }
        const sv = sanitizeValue(raw, depth + 1, budget, seen);
        if (sv !== undefined) out.push(sv);
      }
      return out;
    }
    // Objects that define toJSON (other than Date, handled above).
    const withToJson = obj as { toJSON?: unknown };
    if (typeof withToJson.toJSON === 'function') {
      try {
        return sanitizeValue((withToJson.toJSON as () => unknown)(), depth + 1, budget, seen);
      } catch {
        return undefined;
      }
    }
    // Plain object or class instance: own enumerable string-keyed properties.
    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch {
      return undefined;
    }
    const out: JsonObject = {};
    let kept = 0;
    for (const key of keys) {
      if (kept >= MAX_OBJECT_KEYS || budget.nodes <= 0) break;
      const sk = sanitizeKey(key);
      if (sk === undefined) continue;
      let raw: unknown;
      try {
        raw = (obj as Record<string, unknown>)[key];
      } catch {
        continue; // throwing getter
      }
      const sv = sanitizeValue(raw, depth + 1, budget, seen);
      if (sv !== undefined) {
        out[sk] = sv;
        kept += 1;
      }
    }
    return out;
  } catch {
    // A shape probe (instanceof / toJSON access) on a hostile value threw —
    // drop just this value, never the whole payload.
    return undefined;
  } finally {
    if (added) seen.delete(obj); // allow the same object on sibling branches (DAGs)
  }
}

/**
 * Sanitize a `properties` payload. Non-object inputs (arrays, primitives,
 * buffers…) are dropped entirely; the result is always a plain, bounded,
 * JSON-safe object or `undefined`. Never throws.
 */
export function sanitizeProperties(input: unknown): JsonObject | undefined {
  try {
    if (input === null || input === undefined) return undefined;
    if (typeof input !== 'object' || Array.isArray(input) || input instanceof Date || isBinary(input)) return undefined;
    const v = sanitizeValue(input, 0, { nodes: MAX_TOTAL_NODES }, new Set());
    if (v === undefined || v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
    return Object.keys(v).length > 0 ? v : undefined;
  } catch {
    return undefined; // absolute last resort — sanitization itself must never throw
  }
}

/**
 * Distill an arbitrary thrown value into `{ name, message }` — no stacks,
 * no symbolication, per the event contract. Never throws.
 */
export function distillError(error: unknown): { name: string; message: string } {
  try {
    if (error instanceof Error) {
      return {
        name: sanitizeString(error.name || 'Error', MAX_NAME_LENGTH) || 'Error',
        message: sanitizeString(typeof error.message === 'string' ? error.message : String(error.message ?? ''), MAX_MESSAGE_LENGTH),
      };
    }
    if (typeof error === 'string') {
      return { name: 'Error', message: sanitizeString(error, MAX_MESSAGE_LENGTH) };
    }
    if (error && typeof error === 'object') {
      const anyErr = error as { name?: unknown; message?: unknown; constructor?: { name?: unknown } };
      const rawName = typeof anyErr.name === 'string' && anyErr.name.trim() ? anyErr.name : typeof anyErr.constructor?.name === 'string' ? anyErr.constructor.name : 'Error';
      const rawMessage = typeof anyErr.message === 'string' ? anyErr.message : String(error);
      return {
        name: sanitizeString(rawName, MAX_NAME_LENGTH) || 'Error',
        message: sanitizeString(rawMessage, MAX_MESSAGE_LENGTH),
      };
    }
    return { name: 'Error', message: sanitizeString(String(error), MAX_MESSAGE_LENGTH) };
  } catch {
    return { name: 'Error', message: 'unserializable error' };
  }
}

/** Loose shape check used when reading persisted queue lines back. */
export function isEventShaped(value: unknown): value is MuonEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as MuonEvent).project === 'string' &&
    typeof (value as MuonEvent).type === 'string'
  );
}
