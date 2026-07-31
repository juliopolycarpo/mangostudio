import type { ShellExecDependencies } from '../../../../src/services/shell';

function createTextStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

export interface FakeShellProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exitCode: number | null;
  signalCode: string | null;
  exited: Promise<void>;
  kill: (signal: string) => void;
  complete: (code?: number) => void;
  killCalls: number;
}

/** Child process that stays alive until `complete` or `kill` is called. */
export function createHangingFakeShellProcess(stdout = ''): FakeShellProcess {
  let resolveExited: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  let exitCode: number | null = null;
  let signalCode: string | null = null;
  let dead = false;
  let killCalls = 0;

  return {
    stdout: createTextStream(stdout),
    stderr: createTextStream(''),
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    exited,
    kill(signal: string) {
      killCalls++;
      if (dead) throw new Error('ESRCH');
      dead = true;
      signalCode = signal;
      exitCode = null;
      resolveExited?.();
    },
    complete(code = 0) {
      if (dead) return;
      dead = true;
      exitCode = code;
      signalCode = null;
      resolveExited?.();
    },
    get killCalls() {
      return killCalls;
    },
  };
}

export interface FakeClock {
  now: () => number;
  setTimeout: ShellExecDependencies['setTimeout'];
  clearTimeout: ShellExecDependencies['clearTimeout'];
  advance: (ms: number) => void;
  pendingCount: () => number;
}

/** Deterministic timer queue for shell termination race tests. */
export function createFakeClock(): FakeClock {
  let nowMs = 0;
  const timers: Array<{ id: number; at: number; fn: () => void }> = [];
  let nextId = 1;

  return {
    now: () => nowMs,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, at: nowMs + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id) => {
      const numericId = id as unknown as number;
      const idx = timers.findIndex((timer) => timer.id === numericId);
      if (idx >= 0) timers.splice(idx, 1);
    },
    advance(ms) {
      nowMs += ms;
      const due = timers.filter((timer) => timer.at <= nowMs).sort((a, b) => a.at - b.at);
      for (const timer of due) {
        const idx = timers.findIndex((entry) => entry.id === timer.id);
        // A callback earlier in this drain may have cleared this timer; skip it.
        if (idx < 0) continue;
        timers.splice(idx, 1);
        timer.fn();
      }
    },
    pendingCount: () => timers.length,
  };
}

export function createFakeShellDeps(
  proc: FakeShellProcess,
  clock: FakeClock
): Pick<ShellExecDependencies, 'spawn' | 'setTimeout' | 'clearTimeout' | 'now'> {
  return {
    spawn: () => proc as unknown as ReturnType<typeof Bun.spawn>,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  };
}
