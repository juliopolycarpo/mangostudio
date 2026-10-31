export interface BenchmarkSignalHost {
  readonly on: (name: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
  readonly off: (name: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
}

/** Turns catchable benchmark cancellation into normal child cleanup. Example: const cancellation = benchmarkCancellation(); try { await run(cancellation.signal); } finally { cancellation.dispose(); } */
export function benchmarkCancellation(host: BenchmarkSignalHost = process): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Benchmark canceled by SIGINT'));
  const terminate = () => controller.abort(new Error('Benchmark canceled by SIGTERM'));
  host.on('SIGINT', interrupt);
  host.on('SIGTERM', terminate);
  return {
    signal: controller.signal,
    dispose: () => {
      host.off('SIGINT', interrupt);
      host.off('SIGTERM', terminate);
    },
  };
}

/** Bounds an awaited handshake/request by cancellation without leaving an unhandled losing promise. Example: await withBenchmarkCancellation(session.ready, signal). */
export async function withBenchmarkCancellation<T>(
  task: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  let aborted: (() => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(signal.reason ?? new Error('Benchmark canceled'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
  try {
    return await Promise.race([cancellation, task]);
  } finally {
    if (aborted) signal.removeEventListener('abort', aborted);
  }
}
