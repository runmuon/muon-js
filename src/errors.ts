/**
 * Opt-in host-global error capture (`captureErrors: true`).
 *
 * Do-no-harm rules enforced here:
 * - `uncaughtException` is observed via `process.on('uncaughtExceptionMonitor')`
 *   — the monitor hook fires BEFORE any regular handler and, crucially, does
 *   NOT count as "handling" the exception. The host's own handlers (or Node's
 *   default print-and-exit) run exactly as if Muon were not installed. The
 *   crash is persisted to disk synchronously (a dying process cannot finish a
 *   network call) and delivered on the next start.
 * - `unhandledRejection`: if the host has its own listener(s), Muon only
 *   observes and reports; the host stays in charge. If Muon would be the ONLY
 *   listener, subscribing would silently swallow the rejection (Node skips its
 *   default crash when any listener exists) — so Muon persists the crash and
 *   re-raises the reason on the next tick, faithfully restoring Node's default
 *   behavior. The SDK never calls `process.exit()` and never swallows.
 * - Handlers themselves never throw.
 */

import type { MuonCore } from './core.js';

interface InstalledHooks {
  uninstall(): void;
}

let current: InstalledHooks | null = null;

export function installErrorHooks(core: MuonCore): void {
  if (current) return; // never install twice

  const onUncaught = (error: unknown): void => {
    try {
      core.persistCrashSync(error);
    } catch {
      // never interfere with the host's crash handling
    }
  };

  const onRejection = (reason: unknown): void => {
    try {
      if (process.listenerCount('unhandledRejection') === 1) {
        // We are the only listener: our subscription suppressed Node's default
        // (raise as uncaught exception). Persist, then restore the default.
        core.persistCrashSync(reason);
        setImmediate(() => {
          throw reason; // deliberate: reproduces Node's default crash path
        });
      } else {
        // The host handles rejections itself and keeps the process alive —
        // report through the normal (deduped, rate-limited) pipeline.
        core.captureError(reason);
      }
    } catch {
      // never interfere with the host's rejection handling
    }
  };

  process.on('uncaughtExceptionMonitor', onUncaught);
  process.on('unhandledRejection', onRejection);
  current = {
    uninstall() {
      process.removeListener('uncaughtExceptionMonitor', onUncaught);
      process.removeListener('unhandledRejection', onRejection);
      current = null;
    },
  };
}

export function uninstallErrorHooks(): void {
  try {
    current?.uninstall();
  } catch {
    current = null;
  }
}
