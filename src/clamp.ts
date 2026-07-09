/**
 * Numeric option clamping shared by `init()`. Kept in its own module so the
 * bound logic (min/max) is unit-testable in isolation without widening the
 * public package entry.
 */

/**
 * Coerce an option to a finite integer within `[min, max]`. Non-numbers,
 * `NaN`, and `±Infinity` fall back to `fallback`. `max` defaults to
 * `Number.MAX_SAFE_INTEGER`, but callers that persist to memory/disk MUST
 * pass a real upper bound so a hostile option can't drive the SDK to OOM.
 */
export function clampInt(value: unknown, fallback: number, min: number, max: number = Number.MAX_SAFE_INTEGER): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}
