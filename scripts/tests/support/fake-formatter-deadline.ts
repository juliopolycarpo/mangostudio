interface Deadline {
  readonly at: number;
  readonly callback: () => void;
}

/**
 * A clock whose timers run at their scheduled instant, including during a cold hook start.
 * @example const clock = new FormatterClock(); clock.advance(5_000);
 */
export class FormatterClock {
  now = 0;
  private nextTimer = 0;
  private readonly timers = new Map<number, Deadline>();

  schedule = (callback: () => void, delay = 0): ReturnType<typeof setTimeout> => {
    const timer = ++this.nextTimer;
    this.timers.set(timer, { at: this.now + delay, callback });
    return timer as unknown as ReturnType<typeof setTimeout>;
  };

  cancel = (timer: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(timer as unknown as number);
  };

  advance(ms: number): void {
    const until = this.now + ms;
    while (true) {
      const due = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due || due[1].at > until) break;
      this.now = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.now = until;
  }
}

/**
 * A hanging formatter whose fake pid is accepted only by the scoped signal recorders.
 * @example const formatter = new HangingFormatter(clock); formatter.spawn(['rustfmt', file]);
 */
export class HangingFormatter {
  readonly pid = 123_456_789;
  readonly killedAt: number[] = [];
  readonly treeStops: string[] = [];
  startedAt = 0;
  private reportStarted: () => void = () => undefined;
  readonly started = new Promise<void>((resolve) => {
    this.reportStarted = resolve;
  });
  private reportExit: (exit: number) => void = () => undefined;
  readonly exited = new Promise<number>((resolve) => {
    this.reportExit = resolve;
  });

  constructor(private readonly clock: FormatterClock) {}

  spawn = (command: unknown): ReturnType<typeof Bun.spawn> => {
    if (!Array.isArray(command) || command[0] !== 'rustfmt')
      throw new Error(`expected rustfmt command; received ${JSON.stringify(command)}`);
    // Model cold hook/process startup before runFormatter arms its own timer.
    this.clock.advance(6_000);
    this.startedAt = this.clock.now;
    this.reportStarted();
    return { pid: this.pid, exited: this.exited, kill: this.kill } as unknown as ReturnType<
      typeof Bun.spawn
    >;
  };

  signal = (pid: number, signal?: string | number): true => {
    if (pid !== -this.pid || signal !== 'SIGKILL')
      throw new Error(`expected fake group -${this.pid} SIGKILL; received ${pid} ${signal}`);
    this.treeStops.push('group');
    return true;
  };

  taskkill = (command: unknown): ReturnType<typeof Bun.spawnSync> => {
    const expected = ['taskkill', '/T', '/F', '/PID', String(this.pid)];
    if (JSON.stringify(command) !== JSON.stringify(expected))
      throw new Error(
        `expected fake taskkill ${JSON.stringify(expected)}; received ${JSON.stringify(command)}`
      );
    this.treeStops.push('taskkill');
    return { exitCode: 0 } as ReturnType<typeof Bun.spawnSync>;
  };

  private kill = (signal: unknown): void => {
    if (signal !== 'SIGKILL')
      throw new Error(`expected formatter SIGKILL; received ${String(signal)}`);
    this.killedAt.push(this.clock.now);
    this.release();
  };

  release(): void {
    this.reportExit(0);
  }
}
