/**
 * Muon analytics for Node.js.
 *
 * ```ts
 * import * as muon from '@runmuon/node';
 *
 * muon.init('YOUR_PROJECT_ID', 'https://muon.run');
 * muon.track('signup_completed', { plan: 'pro' });
 * muon.pageView('/pricing', 'Pricing');
 * muon.identify('user_123');
 * await muon.shutdown();
 * ```
 *
 * Every public function is throw-safe: no exception ever escapes into the
 * host, no promise returned here ever rejects.
 */

import { hostname as osHostname } from 'node:os';
import { clampInt } from './clamp.js';
import { MuonCore, type CoreConfig } from './core.js';
import { installErrorHooks, uninstallErrorHooks } from './errors.js';
import { defaultQueueDir } from './queue.js';

export type { JsonObject, JsonValue, MuonEvent } from './event.js';

export interface MuonOptions {
  /** Flush automatically once this many events are buffered. Default 20. */
  flushAt?: number;
  /** Also flush on this interval, in milliseconds. Default 15_000. */
  flushInterval?: number;
  /** Hard cap on buffered events; oldest are dropped past it. Default 10_000. */
  maxQueueEvents?: number;
  /** Per-request timeout in milliseconds. Default 10_000. */
  requestTimeout?: number;
  /** Install host-global uncaught-exception/rejection hooks. Default false. */
  captureErrors?: boolean;
  /** Release/version reported on events. Default: auto-detected from `MUON_RELEASE` or `npm_package_version`. */
  release?: string;
  /** Disable the SDK entirely — every call becomes a no-op. Default false. */
  disabled?: boolean;
  /** Emit at most one console warning per distinct misconfiguration. Default false. */
  debug?: boolean;
  /** Directory for the offline queue. Default: `MUON_QUEUE_DIR` or `~/.muon`. */
  queueDir?: string;
  /** Max error events reported per process run. Default 100. */
  maxErrorsPerRun?: number;
  /** Max identical (type+message) errors reported per run. Default 5. */
  maxDuplicateErrors?: number;
}

let core: MuonCore | null = null;
let initialized = false;
let debugFlag = false;
let shutdownInFlight: Promise<void> | null = null;
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  if (!debugFlag) return;
  try {
    console.warn(`[muon] ${message}`);
  } catch {
    // a broken console must not break us
  }
}

function buildBatchUrl(host: unknown): string | null {
  try {
    if (typeof host !== 'string' || host.trim().length === 0) return null;
    const u = new URL(host.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.pathname = u.pathname.replace(/\/+$/, '') + '/api/track/batch';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function autoRelease(): string | undefined {
  try {
    const env = process.env.MUON_RELEASE || process.env.npm_package_version;
    return typeof env === 'string' && env.trim().length > 0 ? env.trim() : undefined;
  } catch {
    return undefined;
  }
}

function autoHostname(): string | undefined {
  try {
    const h = osHostname();
    return typeof h === 'string' && h.length > 0 ? h : undefined;
  } catch {
    return undefined;
  }
}

function autoLanguage(): string | undefined {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    return typeof locale === 'string' && locale.length > 0 ? locale : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start the SDK. Call once, early. Idempotent: a second call warns (with
 * `debug`) and is ignored. Never throws — a malformed host or project id
 * leaves the SDK inert but safe.
 */
export function init(projectId: string, host: string, options: MuonOptions = {}): void {
  try {
    const opts = options && typeof options === 'object' ? options : {};
    if (initialized) {
      warnOnce('double-init', 'init() called twice — second call ignored');
      return;
    }
    initialized = true;
    debugFlag = opts.debug === true; // debug is a property of the active instance
    if (opts.disabled === true) return; // inert by request — every call no-ops
    if (typeof projectId !== 'string' || projectId.trim().length === 0) {
      warnOnce('bad-project-id', 'init() called with an empty or non-string projectId — SDK disabled');
      return;
    }
    const batchUrl = buildBatchUrl(host);
    if (batchUrl === null) {
      warnOnce('bad-host', `init() called with an invalid host URL (${String(host)}) — SDK disabled`);
      return;
    }
    const cfg: CoreConfig = {
      projectId: projectId.trim(),
      batchUrl,
      flushAt: clampInt(opts.flushAt, 20, 1, 1000),
      // upper bound = max 32-bit signed ms; beyond it setInterval overflows to a
      // ~1ms busy wakeup and prints a TimeoutOverflowWarning (violates "fails quiet")
      flushIntervalMs: clampInt(opts.flushInterval, 15_000, 1000, 2_147_483_647),
      maxQueueEvents: clampInt(opts.maxQueueEvents, 10_000, 1, 1_000_000),
      requestTimeoutMs: clampInt(opts.requestTimeout, 10_000, 100, 120_000),
      release: typeof opts.release === 'string' && opts.release.trim().length > 0 ? opts.release.trim() : autoRelease(),
      debug: debugFlag,
      queueDir: typeof opts.queueDir === 'string' && opts.queueDir.trim().length > 0 ? opts.queueDir : defaultQueueDir(),
      hostname: autoHostname(),
      language: autoLanguage(),
      maxErrorsPerRun: clampInt(opts.maxErrorsPerRun, 100, 0, 1_000_000),
      maxDuplicateErrors: clampInt(opts.maxDuplicateErrors, 5, 1),
    };
    core = new MuonCore(cfg);
    if (opts.captureErrors === true) installErrorHooks(core);
  } catch {
    // init must never throw into the host
  }
}

/** Record a custom event with optional properties. */
export function track(name: string, properties?: Record<string, unknown>): void {
  try {
    if (core === null) {
      warnOnce('not-initialized', 'track() called before init() — event dropped');
      return;
    }
    core.track(name, properties);
  } catch {
    // never throws
  }
}

/** Record a page view by path. */
export function pageView(path: string, title?: string): void {
  try {
    if (core === null) {
      warnOnce('not-initialized', 'pageView() called before init() — event dropped');
      return;
    }
    core.pageView(path, title);
  } catch {
    // never throws
  }
}

/** Associate subsequent events with a user id. */
export function identify(distinctId: string): void {
  try {
    core?.identify(distinctId);
  } catch {
    // never throws
  }
}

/** Override the release/version reported on subsequent events. */
export function setRelease(version: string): void {
  try {
    core?.setRelease(version);
  } catch {
    // never throws
  }
}

/** Report a caught error as a distilled `browser_error` event (no stacks). */
export function captureError(error: unknown, page?: string): void {
  try {
    core?.captureError(error, page);
  } catch {
    // never throws
  }
}

/** Force-send buffered events now. Safe anytime; never rejects. */
export function flush(): Promise<void> {
  try {
    return core ? core.flush() : Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}

/**
 * Final best-effort flush, then release every resource (timer, hooks).
 * Idempotent and safe to call anytime; never rejects. After shutdown the
 * module can be `init()`ed again (useful for tests and long-lived workers).
 */
export function shutdown(): Promise<void> {
  try {
    if (shutdownInFlight) return shutdownInFlight;
    const c = core;
    core = null;
    initialized = false;
    // A shutdown ends this run: reset the per-run warn-once state and debug
    // flag so a subsequent init() starts clean (the module supports re-init).
    warned.clear();
    debugFlag = false;
    uninstallErrorHooks();
    if (c === null) return Promise.resolve();
    shutdownInFlight = c
      .shutdown()
      .catch(() => undefined)
      .finally(() => {
        shutdownInFlight = null;
      });
    return shutdownInFlight;
  } catch {
    return Promise.resolve();
  }
}

const Muon = { init, track, pageView, identify, setRelease, captureError, flush, shutdown };
export default Muon;
