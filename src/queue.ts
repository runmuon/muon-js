/**
 * Disk persistence for the pending-event queue (JSON-lines) and for crash
 * records written by the uncaught-exception hook (delivered on next start).
 *
 * Do-no-harm rules enforced here:
 * - No sync fs on the hot path — everything is `fs/promises`. Writes are
 *   COALESCED: a synchronous burst of N `persist()` calls yields ONE debounced
 *   disk write (at most one write in flight + one trailing write), never N. The
 *   debounce timer is `unref()`ed so it can never keep the process alive.
 * - Every failure is swallowed: an unwritable directory (read-only, disk full)
 *   degrades the store to memory-only for the rest of the run — no throw ever.
 * - Reads are bounded: only the tail of a large queue file is read, and only
 *   the newest `maxEvents` records are kept — a multi-hundred-MB file can never
 *   blow memory or trip `ERR_STRING_TOO_LONG`.
 * - Corrupt data degrades line-by-line: valid lines load, bad ones are skipped.
 * - The one sync exception is `appendCrashSync`, used only from the
 *   uncaught-exception path where the process is about to die and async IO
 *   would be lost; the crash file is capped so a crash-loop can't grow it
 *   without bound.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isEventShaped, type MuonEvent } from './event.js';

/** Default cap on records loaded/kept when the caller doesn't specify one. */
const DEFAULT_MAX_EVENTS = 10_000;
/** Debounce window: rapid `persist()` calls collapse into one write per window. */
const WRITE_DEBOUNCE_MS = 250;
/** Never read more than this many bytes from the tail of a queue/crash file. */
const READ_TAIL_MAX_BYTES = 32 * 1024 * 1024;
/** Cap on the crash file so a crash-loop can't grow it without bound. */
const CRASH_MAX_BYTES = 256 * 1024;
/** Cap on crash records kept (also bounds `loadCrashes`). */
const CRASH_MAX_EVENTS = 500;

/** `MUON_QUEUE_DIR` if set, else `~/.muon`. */
export function defaultQueueDir(): string {
  const env = process.env.MUON_QUEUE_DIR;
  if (typeof env === 'string' && env.trim().length > 0) return env;
  try {
    return join(homedir(), '.muon');
  } catch {
    return join(process.cwd(), '.muon');
  }
}

export class QueueStore {
  readonly queueFile: string;
  readonly crashFile: string;
  /** True once a write has failed — the store keeps working in memory only. */
  memoryOnly = false;

  private readonly dir: string;
  private readonly onDegrade: (() => void) | undefined;
  private readonly maxEvents: number;
  private readonly debounceMs: number;

  /** Latest snapshot waiting to be written; `null` when nothing is pending. */
  private latest: MuonEvent[] | null = null;
  /** A write is currently in flight (single-flight guarantee). */
  private writing = false;
  /** Debounce timer for the trailing write; `null` when none is scheduled. */
  private timer: NodeJS.Timeout | null = null;
  /** When set, drain immediately (bypass debounce) until nothing is pending. */
  private forceDrain = false;
  /** Resolves when the currently-pending data is on disk (or memory-only). */
  private drainPromise: Promise<void> = Promise.resolve();
  private drainResolve: (() => void) | null = null;

  constructor(dir: string, name: string = 'default', onDegrade?: () => void, maxEvents: number = DEFAULT_MAX_EVENTS, debounceMs: number = WRITE_DEBOUNCE_MS) {
    this.dir = dir;
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'default';
    this.queueFile = join(dir, `${safe}.queue.jsonl`);
    this.crashFile = join(dir, `${safe}.crash.jsonl`);
    this.onDegrade = onDegrade;
    this.maxEvents = Number.isFinite(maxEvents) && maxEvents > 0 ? Math.floor(maxEvents) : DEFAULT_MAX_EVENTS;
    this.debounceMs = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : WRITE_DEBOUNCE_MS;
  }

  /** Load the persisted queue (newest `maxEvents` only). Never throws. */
  async load(): Promise<MuonEvent[]> {
    return this.readEvents(this.queueFile, this.maxEvents);
  }

  /**
   * Persist a snapshot of the queue. Calls COALESCE: a burst of rapid calls
   * schedules a single debounced write of the latest state. The returned
   * promise settles when this snapshot (or a newer one) is on disk; it never
   * rejects.
   */
  persist(events: MuonEvent[]): Promise<void> {
    this.latest = events;
    const drained = this.trackDrain();
    this.scheduleWrite();
    return drained;
  }

  /**
   * Force any pending write to happen NOW and await it (used by shutdown, the
   * exit path, and tests). Bypasses the debounce. Never rejects.
   */
  settle(): Promise<void> {
    if (this.latest === null && !this.writing) return Promise.resolve();
    const drained = this.trackDrain();
    this.forceDrain = true;
    this.flushNow();
    return drained;
  }

  /**
   * SYNC on purpose — called only from the uncaught-exception path, where the
   * process is about to die and async IO would never complete. Never throws.
   * The crash file is capped (drop-oldest) so a crash-loop can't grow it.
   */
  appendCrashSync(event: MuonEvent): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const line = JSON.stringify(event) + '\n';
      try {
        const st = statSync(this.crashFile);
        if (st.size + line.length > CRASH_MAX_BYTES) {
          // Over cap: keep only the newest records, drop the rest.
          const text = readFileSync(this.crashFile, 'utf8');
          const lines = text.split('\n').filter((l) => l.trim().length > 0);
          const keep = lines.slice(-CRASH_MAX_EVENTS + 1);
          writeFileSync(this.crashFile, keep.length > 0 ? keep.join('\n') + '\n' : '', 'utf8');
        }
      } catch {
        // crash file doesn't exist yet, or is unreadable — just append below
      }
      appendFileSync(this.crashFile, line, 'utf8');
    } catch {
      // nothing safe to do in a crashing process
    }
  }

  /** Load crash records written by a previous run (capped). Never throws. */
  async loadCrashes(): Promise<MuonEvent[]> {
    return this.readEvents(this.crashFile, Math.min(this.maxEvents, CRASH_MAX_EVENTS));
  }

  async clearCrashes(): Promise<void> {
    try {
      await rm(this.crashFile, { force: true });
    } catch {
      // read-only dir — the records will be deduplicated by at-least-once delivery
    }
  }

  // -------------------------------------------------------------------------
  // Coalescing write machinery
  // -------------------------------------------------------------------------

  private trackDrain(): Promise<void> {
    if (this.drainResolve === null) {
      this.drainPromise = new Promise<void>((resolve) => {
        this.drainResolve = resolve;
      });
    }
    return this.drainPromise;
  }

  private markDrained(): void {
    this.forceDrain = false;
    const resolve = this.drainResolve;
    this.drainResolve = null;
    if (resolve) resolve();
  }

  private scheduleWrite(): void {
    if (this.writing || this.timer !== null) return; // already writing or scheduled
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushNow();
    }, this.debounceMs);
    this.timer.unref?.(); // NEVER keep the host process alive for a queue write
  }

  private flushNow(): void {
    if (this.writing) return; // single-flight: the in-flight write picks up `latest` when done
    /* v8 ignore next 4 -- defensive guard: unreachable under current invariants
       (flushNow is only entered with latest!==null), kept so a future caller
       can't serialize a null snapshot. Redundant with the drain at ~line 203. */
    if (this.latest === null) {
      this.markDrained();
      return;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.writing = true;
    const events = this.latest;
    this.latest = null;
    void this.writeSnapshot(events).finally(() => {
      this.writing = false;
      if (this.latest !== null) {
        // Data arrived during the write — one trailing write. Immediate if
        // someone is force-draining (shutdown/settle), else debounced.
        if (this.forceDrain) this.flushNow();
        else this.scheduleWrite();
      } else {
        this.markDrained();
      }
    });
  }

  private async writeSnapshot(events: MuonEvent[]): Promise<void> {
    if (this.memoryOnly) return;
    try {
      await mkdir(this.dir, { recursive: true });
      if (events.length === 0) {
        await rm(this.queueFile, { force: true });
        return;
      }
      let data = '';
      for (const ev of events) {
        try {
          data += JSON.stringify(ev) + '\n';
        } catch {
          // unserializable event (should be impossible post-sanitization) — skip
        }
      }
      const tmp = this.queueFile + '.tmp';
      await writeFile(tmp, data, 'utf8');
      await rename(tmp, this.queueFile);
    } catch {
      // disk full, permission denied, … — degrade to memory-only, warn once
      this.memoryOnly = true;
      try {
        this.onDegrade?.();
      } catch {
        // never let a callback break the chain
      }
    }
  }

  /**
   * Read a JSON-lines file, keeping only the newest `cap` well-formed records.
   * Bounded: reads at most the last `READ_TAIL_MAX_BYTES` of the file, so a
   * gigantic file can never load into one huge string (ERR_STRING_TOO_LONG) or
   * blow memory. Corrupt lines are skipped. Never throws.
   */
  private async readEvents(file: string, cap: number): Promise<MuonEvent[]> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(file, 'r');
    } catch {
      return []; // missing file or unreadable — empty queue
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return [];
      let start = 0;
      let droppedPartialHead = false;
      if (size > READ_TAIL_MAX_BYTES) {
        start = size - READ_TAIL_MAX_BYTES; // read only the newest tail
        droppedPartialHead = true;
      }
      const length = size - start;
      const buf = Buffer.allocUnsafe(length);
      let off = 0;
      while (off < length) {
        const { bytesRead } = await handle.read(buf, off, length - off, start + off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      const text = buf.subarray(0, off).toString('utf8');
      const lines = text.split('\n');
      const out: MuonEvent[] = [];
      // If we started mid-file, the first line is very likely a partial record.
      const startIdx = droppedPartialHead ? 1 : 0;
      for (let i = startIdx; i < lines.length; i++) {
        const l = lines[i]!.trim();
        if (!l) continue;
        try {
          const parsed: unknown = JSON.parse(l);
          if (isEventShaped(parsed)) out.push(parsed);
        } catch {
          // truncated/garbage line — skip it, keep the rest
        }
      }
      // Keep only the newest `cap` records (drop-oldest), matching the buffer cap.
      return out.length > cap ? out.slice(out.length - cap) : out;
    } catch {
      return [];
    } finally {
      try {
        await handle.close();
      } catch {
        // best effort
      }
    }
  }
}
