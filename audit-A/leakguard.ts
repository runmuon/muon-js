/** Records any unhandled rejection / uncaught exception that reaches the host. */
export interface Leaks {
  rejections: unknown[];
  exceptions: unknown[];
  stop(): void;
}

export function installLeakGuard(): Leaks {
  const leaks: Leaks = { rejections: [], exceptions: [], stop() {} };
  const onRej = (r: unknown) => leaks.rejections.push(r);
  const onExc = (e: unknown) => leaks.exceptions.push(e);
  process.on('unhandledRejection', onRej);
  process.on('uncaughtException', onExc);
  leaks.stop = () => {
    process.removeListener('unhandledRejection', onRej);
    process.removeListener('uncaughtException', onExc);
  };
  return leaks;
}

export async function drainMicrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}
