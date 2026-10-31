import {
  type NativeProcess,
  POSIX_CENSUS_TIMEOUT_MS,
  scopeNativeProcesses,
  snapshotNativeProcesses,
  WINDOWS_CENSUS_TIMEOUT_MS,
} from '../lib/native-bun-qualification-process';

/** A retained direct child; `kill` always acts through the original process handle. */
export interface BenchmarkChildHandle {
  readonly pid: number;
  readonly exited: Promise<unknown>;
  alive(): boolean;
  kill(signal: NodeJS.Signals): void;
}

/** Native observations and signals are injectable for deterministic ownership controls. */
export interface BenchmarkScopeHost {
  readonly platform: NodeJS.Platform;
  readonly parentPid: number;
  snapshot(): Promise<readonly NativeProcess[]>;
  signal(pid: number, signal: NodeJS.Signals): void;
  now(): number;
  pause(ms: number): Promise<void>;
}

const SCOPE_HOST: BenchmarkScopeHost = {
  platform: process.platform,
  parentPid: process.pid,
  snapshot: snapshotNativeProcesses,
  signal: (pid, signal) => {
    process.kill(pid, signal);
  },
  now: () => performance.now(),
  pause: (ms) => Bun.sleep(ms),
};

/** Bound one observation without leaving an unhandled losing promise. */
async function within<T>(operation: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface BenchmarkSettlement {
  readonly settled: boolean;
  readonly errors: readonly string[];
  readonly survivors: readonly NativeProcess[];
}

/**
 * Track an actual benchmark child by native birth identity without changing readiness timing.
 * @example const scope = new BenchmarkChildScope(child); const result = await scope.stop();
 */
export class BenchmarkChildScope {
  private rootIdentity: string | null = null;
  private observed: NativeProcess[] = [];
  private current: NativeProcess[] = [];
  private readonly errors: string[] = [];
  private readonly initial: Promise<void>;

  constructor(
    private readonly child: BenchmarkChildHandle,
    private readonly host: BenchmarkScopeHost = SCOPE_HOST
  ) {
    // Observe an early spawn/exit rejection until stop() records its cleanup failure.
    void this.child.exited.catch(() => {});
    this.initial = this.capture(true);
  }

  /** Wait until the initial identity observation completes without delaying readiness listeners.
   * @example await scope.initialObservation();
   */
  async initialObservation(): Promise<void> {
    await this.initial;
  }

  private async capture(initial = false): Promise<void> {
    const liveAtDispatch = this.child.alive();
    try {
      const timeout =
        this.host.platform === 'win32' ? WINDOWS_CENSUS_TIMEOUT_MS : POSIX_CENSUS_TIMEOUT_MS;
      const rows = await within(this.host.snapshot(), timeout + 1_000);
      if (!rows) throw new Error(`native census did not settle within ${timeout + 1_000}ms`);
      const root = rows.find((row) => row.pid === this.child.pid);
      if (initial) {
        if (
          !liveAtDispatch ||
          !this.child.alive() ||
          root?.parentPid !== this.host.parentPid ||
          (this.host.platform !== 'win32' && root.group !== this.child.pid)
        ) {
          throw new Error(`expected live benchmark root ${this.child.pid} with owned parent/group`);
        }
      }
      if (!initial && !this.rootIdentity) return;
      if (!initial && liveAtDispatch && root && root.identity !== this.rootIdentity) {
        throw new Error(`benchmark root ${this.child.pid}: native birth identity changed`);
      }
      const scoped = scopeNativeProcesses(rows, {
        rootPid: this.child.pid,
        rootAlive: liveAtDispatch,
        rootIdentity: this.rootIdentity,
        observed: this.observed,
      });
      this.rootIdentity = scoped.rootIdentity;
      this.observed = scoped.observed;
      this.current = scoped.current;
    } catch (error) {
      this.current = [];
      this.errors.push(`benchmark child census failed: ${String(error)}`);
    }
  }

  private signalOwned(signal: NodeJS.Signals): void {
    const group =
      this.host.platform !== 'win32' &&
      this.current.some(
        (row) =>
          row.group === this.child.pid && this.observed.some((old) => old.identity === row.identity)
      );
    if (group) {
      try {
        this.host.signal(-this.child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          this.errors.push(`benchmark group signal failed: ${String(error)}`);
      }
    }
    for (const row of this.current) {
      if (group && row.group === this.child.pid) continue;
      if (!this.observed.some((old) => old.identity === row.identity)) continue;
      if (row.pid === this.child.pid) continue;
      try {
        this.host.signal(row.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          this.errors.push(`benchmark descendant signal failed: ${String(error)}`);
      }
    }
    if (
      !group &&
      this.child.alive() &&
      this.current.some((row) => row.identity === this.rootIdentity)
    ) {
      try {
        this.child.kill(signal);
      } catch (error) {
        this.errors.push(`benchmark child signal failed: ${String(error)}`);
      }
    }
  }

  /** Stop and verify the observed child scope; unknown or surviving ownership is not settlement. */
  async stop(): Promise<BenchmarkSettlement> {
    await this.initial;
    if (!this.rootIdentity)
      this.errors.push(`benchmark child: expected initial native identity for ${this.child.pid}`);
    await this.capture();
    if (!this.child.alive() && !this.current.some((row) => row.group === this.child.pid))
      this.errors.push(
        `benchmark child ${this.child.pid}: root exited without a verified group anchor`
      );
    this.signalOwned('SIGTERM');
    let deadline = this.host.now() + 5_000;
    let killed = false;
    while (true) {
      await this.capture();
      if (!this.current.length && !this.child.alive()) break;
      if (this.host.now() >= deadline) {
        if (killed) break;
        this.signalOwned('SIGKILL');
        killed = true;
        deadline = this.host.now() + 2_000;
      }
      await this.host.pause(25);
    }
    let exited = false;
    try {
      exited =
        (await within(
          this.child.exited.then(() => true),
          2_000
        )) ?? false;
    } catch (error) {
      this.errors.push(`benchmark child exit failed: ${String(error)}`);
    }
    if (!exited)
      this.errors.push(`benchmark child ${this.child.pid}: exit not confirmed within 2000ms`);
    if (this.current.length)
      this.errors.push(`benchmark child ${this.child.pid}: observed processes survived cleanup`);
    return {
      settled: this.errors.length === 0 && this.current.length === 0 && !!exited,
      errors: [...this.errors],
      survivors: [...this.current],
    };
  }
}

/** Wait for cleanup work without letting an uncooperative producer block the benchmark.
 * @example const done = await settleBenchmarkWork(child.exited, 2000);
 */
export async function settleBenchmarkWork(
  operation: Promise<unknown>,
  ms: number
): Promise<string | null> {
  try {
    const settled = await within(
      operation.then(() => true),
      ms
    );
    return settled ? null : `cleanup did not settle within ${ms}ms`;
  } catch (error) {
    return `cleanup failed: ${String(error)}`;
  }
}

/** Drain a benchmark pipe and permit bounded cancellation when inherited handles stay open.
 * @example const output = pumpBenchmarkStream(child.stdout); await output.done;
 */
export function pumpBenchmarkStream(stream: ReadableStream<Uint8Array>): {
  done: Promise<void>;
  text(): string;
  cancel(): Promise<void>;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const done = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  })();
  // Keep an early rejection observed until the cleanup path collects it.
  void done.catch(() => {});
  return { done, text: () => text, cancel: () => reader.cancel() };
}

/** Retain a cleanup cause while preserving any earlier benchmark failure.
 * @example const failure = recordBenchmarkCleanup(errors, 'readiness failed', 'Startup', 'census failed');
 */
export function recordBenchmarkCleanup(
  errors: string[],
  failure: string | null,
  label: string,
  cause: string
): string {
  errors.push(cause);
  return failure ?? `${label} cleanup: ${cause}`;
}
