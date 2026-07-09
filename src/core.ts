/**
 * The SDK engine: buffers events, persists them, flushes gzip'd batches.
 *
 * Do-no-harm rules enforced here:
 * - Flushes are serialized on a promise chain — an in-flight flush and new
 *   events can never corrupt the buffer (at-least-once delivery).
 * - The buffer is hard-capped (drop-oldest); errors are deduped and
 *   rate-limited per run.
 * - The flush timer is `unref()`ed; `beforeExit` triggers one bounded
 *   best-effort flush that can never delay process exit beyond ~2s.
 * - Every internal promise is caught — the SDK never emits an unhandled
 *   rejection into the host.
 * - Failed batches re-queue with capped exponential backoff; permanently
 *   rejected batches (4xx) are dropped, not retried forever.
 */

import { distillError, sanitizeEventName, sanitizeProperties, sanitizeShortString, type JsonObject, type MuonEvent } from './event.js';
import { QueueStore } from './queue.js';
import { backoffDelay, MAX_BATCH_SIZE, Transport } from './transport.js';

export interface CoreConfig {
  projectId: string;
  /** Fully resolved `…/api/track/batch` URL. */
  batchUrl: string;
  flushAt: number;
  flushIntervalMs: number;
  maxQueueEvents: number;
  requestTimeoutMs: number;
  release?: string | undefined;
  debug: boolean;
  queueDir: string;
  hostname?: string | undefined;
  language?: string | undefined;
  maxErrorsPerRun: number;
  maxDuplicateErrors: number;
}

/** Bound on how long a `beforeExit` best-effort flush may take. */
const EXIT_FLUSH_BUDGET_MS = 2_000;
const EXIT_FLUSH_TIMEOUT_MS = 1_500;

export class MuonCore {
  private readonly cfg: CoreConfig;
  private readonly store: QueueStore;
  private readonly transport: Transport;
  /** Single stable array — mutated in place, never reassigned. */
  private readonly buffer: MuonEvent[] = [];
  private readonly ready: Promise<void>;
  private readonly warned = new Set<string>();

  private distinctId: string | undefined;
  private release: string | undefined;
  private flushChain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private retryAt = 0;
  private stopped = false;
  private shutdownPromise: Promise<void> | null = null;
  private exitFlushStarted = false;
  /** Single-flight guard: at most one auto-flush queued at a time. */
  private autoFlushQueued = false;
  /** True once the persisted backlog has been restored. */
  private restored = false;

  // error flood protection (per process run)
  private errorTotal = 0;
  private readonly errorSeen = new Map<string, number>();
  private readonly crashSeen = new WeakSet<object>();

  private readonly onBeforeExit = (): void => {
    this.exitFlush();
  };

  constructor(cfg: CoreConfig, store?: QueueStore, transport?: Transport) {
    this.cfg = cfg;
    this.release = cfg.release;
    this.store =
      store ??
      new QueueStore(cfg.queueDir, cfg.projectId, () => this.warnOnce('queue-degraded', 'queue persistence unavailable — continuing in memory only'), cfg.maxQueueEvents);
    this.transport = transport ?? new Transport(cfg.batchUrl, cfg.requestTimeoutMs);
    this.ready = this.restore();
    this.timer = setInterval(() => this.onTick(), cfg.flushIntervalMs);
    this.timer.unref?.(); // NEVER keep the host process alive
    process.on('beforeExit', this.onBeforeExit);
  }

  // -------------------------------------------------------------------------
  // Public operations (called via the facade; every one is throw-safe there)
  // -------------------------------------------------------------------------

  track(name: unknown, properties?: unknown): void {
    const n = sanitizeEventName(name);
    if (n === undefined) {
      this.warnOnce('bad-event-name', 'track() called with an empty or non-string event name — event dropped');
      return;
    }
    this.enqueue({ type: 'custom', name: n, properties: sanitizeProperties(properties) });
  }

  pageView(path: unknown, title?: unknown): void {
    let url = sanitizeShortString(path);
    if (url === undefined) {
      this.warnOnce('bad-page-path', 'pageView() called with an empty or non-string path — event dropped');
      return;
    }
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('/')) url = '/' + url;
    this.enqueue({ type: 'page_view', url, title: sanitizeShortString(title, 512) });
  }

  identify(distinctId: unknown): void {
    const id = sanitizeShortString(distinctId, 256);
    if (id === undefined) {
      this.warnOnce('bad-distinct-id', 'identify() called with an empty or non-string id — ignored');
      return;
    }
    this.distinctId = id.trim();
  }

  setRelease(version: unknown): void {
    const v = sanitizeShortString(version, 256);
    if (v === undefined) {
      this.warnOnce('bad-release', 'setRelease() called with an empty or non-string version — ignored');
      return;
    }
    this.release = v.trim();
  }

  captureError(error: unknown, page?: unknown): void {
    const { name, message } = distillError(error);
    if (!this.admitError(name, message)) return;
    this.enqueue({ type: 'browser_error', name, message, page: sanitizeShortString(page) });
  }

  /**
   * Force-send now. Safe to call anytime; the promise NEVER rejects. An
   * explicit flush() bypasses the backoff gate (it's "send now"); auto-flushes
   * respect it (see `autoFlush`).
   */
  flush(timeoutMs?: number, deadline?: number, bypassBackoff = true): Promise<void> {
    const run = this.flushChain.then(() => this.doFlush(timeoutMs, deadline, bypassBackoff)).catch(() => undefined);
    this.flushChain = run;
    return run;
  }

  /** Final best-effort flush + release every resource. Idempotent. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      this.stopped = true; // events arriving from here on are dropped
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      process.removeListener('beforeExit', this.onBeforeExit);
      await this.flush();
      try {
        await this.ready;
        // Capture the final buffer state, then force it durably to disk via
        // settle() (immediate, ref'd write). We must NOT await persist()'s
        // returned promise: it only resolves when the DEBOUNCED, unref'd timer
        // fires, which never happens on an otherwise-idle loop — that would hang
        // shutdown() forever and drop the buffer. settle() forceDrains now.
        void this.store.persist(this.buffer);
        await this.store.settle();
      } catch {
        // persistence is best-effort
      }
    })().catch(() => undefined);
    return this.shutdownPromise;
  }

  /**
   * SYNC crash persistence — the one legal sync-IO path, used only from the
   * uncaught-exception/rejection hooks where the process is about to die.
   * Deduped per run so a crash loop cannot flood the disk. Never throws.
   */
  persistCrashSync(error: unknown): void {
    try {
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        if (this.crashSeen.has(error)) return; // same throwable already recorded
        this.crashSeen.add(error);
      }
      const { name, message } = distillError(error);
      if (!this.admitError(name, message)) return;
      const ev: MuonEvent = { project: this.cfg.projectId, type: 'browser_error', name, message };
      this.decorate(ev);
      this.store.appendCrashSync(ev);
    } catch {
      // never interfere with a crashing host
    }
  }

  // introspection (used by the facade and tests)
  bufferedCount(): number {
    return this.buffer.length;
  }

  /** Resolves when the persisted backlog is restored and pending writes are flushed. */
  async settled(): Promise<void> {
    try {
      await this.ready;
      await this.store.settle();
    } catch {
      // never rejects
    }
  }

  warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    if (!this.cfg.debug) return;
    try {
      console.warn(`[muon] ${message}`);
    } catch {
      // a broken console must not break us
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private admitError(name: string, message: string): boolean {
    if (this.errorTotal >= this.cfg.maxErrorsPerRun) return false;
    const key = name + '\u0001' + message;
    const seen = this.errorSeen.get(key) ?? 0;
    if (seen >= this.cfg.maxDuplicateErrors) return false;
    this.errorSeen.set(key, seen + 1);
    this.errorTotal += 1;
    return true;
  }

  private decorate(ev: MuonEvent): void {
    if (this.cfg.hostname !== undefined) ev.hostname = this.cfg.hostname;
    if (this.cfg.language !== undefined) ev.language = this.cfg.language;
    if (this.release !== undefined) ev.release = this.release;
    if (this.distinctId !== undefined) ev.distinctId = this.distinctId;
  }

  private enqueue(partial: { type: string; name?: string; url?: string; title?: string; properties?: JsonObject | undefined; message?: string; page?: string | undefined }): void {
    if (this.stopped) return;
    const ev: MuonEvent = { project: this.cfg.projectId, type: partial.type };
    if (partial.name !== undefined) ev.name = partial.name;
    if (partial.url !== undefined) ev.url = partial.url;
    if (partial.title !== undefined) ev.title = partial.title;
    this.decorate(ev);
    if (partial.properties !== undefined) ev.properties = partial.properties;
    if (partial.message !== undefined) ev.message = partial.message;
    if (partial.page !== undefined) ev.page = partial.page;

    this.buffer.push(ev);
    this.trim();
    this.schedulePersist();
    if (this.buffer.length >= this.cfg.flushAt) this.autoFlush();
  }

  /**
   * Threshold/interval-triggered flush. Single-flight: a synchronous burst of N
   * track() past `flushAt` schedules AT MOST ONE flush, not N — and it honors
   * the backoff window, so a permanently failing server can't be hammered.
   */
  private autoFlush(): void {
    if (this.autoFlushQueued) return; // one auto-flush in flight/queued at a time
    if (Date.now() < this.retryAt) return; // respect backoff
    this.autoFlushQueued = true;
    const run = this.flushChain.then(() => this.doFlush(undefined, undefined, false)).catch(() => undefined);
    this.flushChain = run;
    void run.finally(() => {
      this.autoFlushQueued = false;
    });
  }

  /** Drop-oldest cap — exact: never more than `maxQueueEvents` buffered. */
  private trim(): void {
    const over = this.buffer.length - this.cfg.maxQueueEvents;
    if (over > 0) this.buffer.splice(0, over);
  }

  /**
   * Persist AFTER the initial restore has completed — otherwise an early
   * enqueue could overwrite the previous run's queue file before it is read.
   */
  private schedulePersist(): void {
    void this.ready.then(() => this.store.persist(this.buffer)).catch(() => undefined);
  }

  private async restore(): Promise<void> {
    try {
      const [persisted, crashes] = await Promise.all([this.store.load(), this.store.loadCrashes()]);
      if (persisted.length === 0 && crashes.length === 0) return;
      // Build the restored head WITHOUT spreading — `...persisted` on a
      // >~125k-element array throws RangeError (too many call args), which would
      // otherwise drop the ENTIRE valid backlog. `concat` and per-element push
      // are safe at any size. Order: [persisted…, crashes…, live-enqueued…].
      const live = this.buffer.splice(0, this.buffer.length); // events enqueued during restore
      const combined = persisted.concat(crashes);
      for (let i = 0; i < live.length; i++) combined.push(live[i]!);
      // Trim to the cap BEFORE loading into the buffer (drop-oldest), so a
      // backlog larger than maxQueueEvents keeps its newest `cap`, never 0.
      const cap = this.cfg.maxQueueEvents;
      const start = combined.length > cap ? combined.length - cap : 0;
      for (let i = start; i < combined.length; i++) this.buffer.push(combined[i]!);
      // Force an immediate durable write (settle force-drains); must NOT await
      // persist()'s debounced, unref'd timer — on an idle loop it never fires,
      // which would hang a later shutdown() and lose post-restore events
      // (same anti-pattern the shutdown path avoids).
      this.store.persist(this.buffer); // crashes are now queued…
      await this.store.settle();
      if (crashes.length > 0) await this.store.clearCrashes(); // …so this can't lose them
    } catch {
      // corrupt/unreadable storage degrades to an empty queue
    }
  }

  private onTick(): void {
    if (this.stopped || this.buffer.length === 0) return;
    if (Date.now() < this.retryAt) return; // respect backoff
    void this.flush();
  }

  /**
   * `beforeExit`: one bounded best-effort flush. The per-request timeout is
   * clamped hard so a stalled server can never delay process exit past ~2s,
   * and the guard flag makes the re-entrant `beforeExit` a no-op.
   */
  private exitFlush(): void {
    if (this.exitFlushStarted || this.stopped || this.buffer.length === 0) return;
    this.exitFlushStarted = true;
    const timeout = Math.min(this.cfg.requestTimeoutMs, EXIT_FLUSH_TIMEOUT_MS);
    void this.flush(timeout, Date.now() + EXIT_FLUSH_BUDGET_MS)
      .then(() => this.store.settle())
      .catch(() => undefined);
  }

  private async doFlush(timeoutMs?: number, deadline?: number, bypassBackoff = true): Promise<void> {
    try {
      await this.ready;
    } catch {
      // restore never rejects, but stay paranoid
    }
    while (this.buffer.length > 0) {
      if (deadline !== undefined && Date.now() >= deadline) return;
      // Honor the backoff window on every non-explicit path. A queued auto-flush
      // that wakes up inside the retry gap MUST NOT re-send the requeued batch —
      // otherwise a 503 burst becomes a back-to-back retry storm.
      if (!bypassBackoff && Date.now() < this.retryAt) return;
      const batch = this.buffer.splice(0, MAX_BATCH_SIZE);
      const res = await this.transport.send(batch, timeoutMs);
      if (res.outcome === 'retry') {
        // transient fault — re-queue at the front, back off
        this.buffer.unshift(...batch);
        this.trim();
        this.failures += 1;
        this.retryAt = Date.now() + backoffDelay(this.failures);
        this.warnOnce('delivery-retrying', `batch delivery failed (${res.status ?? 'network fault'}) — retrying with backoff`);
        void this.store.persist(this.buffer);
        return;
      }
      if (res.outcome === 'ok') {
        this.failures = 0;
        this.retryAt = 0;
      } else {
        // permanent rejection (4xx) — drop, never retry forever
        this.warnOnce('delivery-rejected', `batch rejected by server (${res.status ?? '?'}) — dropped`);
      }
      void this.store.persist(this.buffer);
    }
  }
}
