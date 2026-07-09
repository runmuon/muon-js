import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreConfig } from '../../src/core.js';

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'muon-js-test-'));
}

export async function removeDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** A deterministic CoreConfig for direct MuonCore tests. */
export function coreConfig(queueDir: string, batchUrl: string, overrides: Partial<CoreConfig> = {}): CoreConfig {
  return {
    projectId: 'proj-1',
    batchUrl,
    flushAt: 1000, // high by default so tests control flush timing explicitly
    flushIntervalMs: 60_000,
    maxQueueEvents: 10_000,
    requestTimeoutMs: 5_000,
    release: undefined,
    debug: false,
    queueDir,
    hostname: undefined,
    language: undefined,
    maxErrorsPerRun: 100,
    maxDuplicateErrors: 5,
    ...overrides,
  };
}
