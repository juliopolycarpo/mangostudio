import { readLinuxSmokeProcesses } from './binary-smoke-linux';
import { awaitSmokeCompletion, stopSmokeProcess } from './binary-smoke-process';
import { pumpStream } from './child-streams';
import {
  type NativeProcess,
  scopeNativeProcesses,
  snapshotNativeProcesses,
} from './native-bun-qualification-process';
import { ChildSupervisor, processHost, type SupervisorHost } from './process-tree';

export interface SmokeHubChild {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly exited: Promise<number>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal: NodeJS.Signals): unknown;
}

export interface SmokeHubOptions {
  readonly spawn: () => SmokeHubChild;
  readonly ready: () => Promise<void>;
  readonly snapshot?: () => Promise<NativeProcess[]>;
  readonly platform?: NodeJS.Platform;
  readonly budgetMs?: number;
  readonly requireExitZero?: boolean;
  readonly groupAlive?: (pid: number) => boolean;
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly supervisorHost?: SupervisorHost;
}

/**
 * Own artifact process lifetimes and the exact descendant identities observed before shutdown.
 * A failed start remains owned until stop; callers must use finally even when readiness fails.
 * @example const hub = new SmokeHub(options); try { await hub.start(); } finally { await hub.stop(); }
 */
export class SmokeHub {
  private child: SmokeHubChild | undefined;
  private childExited = false;
  private stderr: ReturnType<typeof pumpStream> | undefined;
  private owned: NativeProcess[] = [];
  private rootIdentity: string | null = null;
  private runtimeBaseline: Set<string> | undefined;
  private runtimeAnchor: NativeProcess | undefined;
  private runtimeOwned: NativeProcess[] = [];
  private release: (() => void) | undefined;
  private readonly supervisor: ChildSupervisor;
  private readonly platform: NodeJS.Platform;
  private readonly snapshot: () => Promise<NativeProcess[]>;
  constructor(private readonly options: SmokeHubOptions) {
    this.supervisor = new ChildSupervisor(options.supervisorHost ?? processHost());
    this.platform = options.platform ?? process.platform;
    this.snapshot =
      options.snapshot ??
      (this.platform === 'linux'
        ? () =>
            readLinuxSmokeProcesses([
              ...(this.child && (!this.childExited || this.rootIdentity)
                ? [
                    {
                      pid: this.child.pid,
                      ...(this.rootIdentity ? { identity: this.rootIdentity } : {}),
                    },
                  ]
                : []),
              ...this.owned,
            ])
        : snapshotNativeProcesses);
  }
  /** Diagnostics from the current hub, including output before readiness. @example console.error(hub.errorText()); */
  errorText(): string {
    return this.stderr?.text() ?? '';
  }
  /** Start the same artifact with the caller's unchanged environment/database. @example await hub.start(); */
  async start(): Promise<void> {
    if (this.child) throw new Error('hub start: expected previous child settled before restart');
    this.owned = [];
    this.rootIdentity = null;
    this.runtimeBaseline = undefined;
    this.runtimeAnchor = undefined;
    this.runtimeOwned = [];
    this.childExited = false;
    const child = this.options.spawn();
    this.child = child;
    // A signalled Windows child resolves exited with 143 while exitCode stays null.
    void child.exited.then(() => {
      if (this.child === child) this.childExited = true;
    });
    this.stderr = pumpStream(child.stderr);
    this.release = this.supervisor.adopt({
      label: 'artifact hub',
      pid: child.pid,
      ownsGroup: this.platform !== 'win32',
      exited: child.exited,
      signal: (signal) => child.kill(signal),
    });
    await this.census();
    await this.options.ready();
  }
  private async census(): Promise<NativeProcess[]> {
    if (!this.child) return [];
    const scoped = scopeNativeProcesses(await this.snapshot(), {
      rootPid: this.child.pid,
      rootAlive: !this.childExited,
      rootIdentity: this.rootIdentity,
      observed: this.owned,
    });
    this.rootIdentity = scoped.rootIdentity;
    this.owned = scoped.observed;
    return scoped.current;
  }
  /**
   * Capture existing hub descendants immediately before an authenticated Local connection.
   * They remain owned for shutdown, but belong to other hub lifetimes such as library warm-up.
   * @example await hub.captureRuntimeBaseline(); await connectLocal(); await hub.observeRuntime();
   */
  async captureRuntimeBaseline(): Promise<void> {
    if (!this.child || this.childExited)
      throw new Error('Local runtime: expected a running hub before connection baseline');
    await this.census();
    this.runtimeBaseline = new Set(this.owned.map((row) => row.identity));
    this.runtimeAnchor = undefined;
    this.runtimeOwned = [];
  }
  /**
   * Record new connection roots and their descendants using process creation identities.
   * Children of a baseline runtime cannot stand in for the authenticated user's runtime.
   * @example await connectLocal(); await hub.observeRuntime();
   */
  async observeRuntime(): Promise<void> {
    if (!this.runtimeBaseline)
      throw new Error('Local runtime: expected connection baseline before observing runtime');
    const current = await this.census();
    const roots = current.filter(
      (row) => row.parentPid === this.child?.pid && !this.runtimeBaseline?.has(row.identity)
    );
    if (!roots.length)
      throw new Error(
        `Local runtime: expected a new owned connection child process | received ${JSON.stringify(current)}`
      );
    this.runtimeAnchor = roots[0];
    this.runtimeOwned = roots;
    this.runtimeCensus(current);
  }
  private runtimeCensus(current: NativeProcess[]): NativeProcess[] {
    const anchor = this.runtimeAnchor;
    if (!anchor) return [];
    const scoped = scopeNativeProcesses(current, {
      rootPid: anchor.pid,
      rootAlive: current.some((row) => row.identity === anchor.identity),
      rootIdentity: anchor.identity,
      observed: this.runtimeOwned,
    });
    this.runtimeOwned = scoped.observed;
    return scoped.current;
  }
  /**
   * Await the recorded connection cohort, retaining baseline descendants for final hub shutdown.
   * @example await disconnectLocal(); await hub.waitForRuntimeExit();
   */
  async waitForRuntimeExit(): Promise<void> {
    if (!this.runtimeAnchor)
      throw new Error('Local runtime: expected an observed connection cohort before exit wait');
    const budgetMs = this.options.budgetMs ?? 30_000;
    const deadline = performance.now() + budgetMs;
    let remaining: NativeProcess[];
    do {
      remaining = this.runtimeCensus(await this.census());
      if (!remaining.length) return;
      await Bun.sleep(10);
    } while (performance.now() < deadline);
    throw new Error(
      `Local runtime: expected disconnected child processes to exit within ${budgetMs}ms | received ${JSON.stringify(remaining)}`
    );
  }
  private async signal(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    const child = this.child;
    if (!child) return;
    let current: NativeProcess[] = [];
    let censusError: Error | undefined;
    try {
      current = await this.census();
    } catch (error) {
      censusError = error instanceof Error ? error : new Error(String(error));
    }
    const ownsGroup = !this.childExited || current.some((row) => row.group === child.pid);
    if (this.platform !== 'win32' && !censusError && !ownsGroup) {
      this.release?.();
      this.release = undefined;
    }
    if (this.platform !== 'win32' && ownsGroup) {
      try {
        (this.options.signalGroup ?? process.kill)(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    } else if (!this.childExited) child.kill(signal);
    if (censusError) throw censusError;
    // A forced cleanup also reaches previously observed descendants that left the hub's group.
    if (signal === 'SIGKILL')
      for (const row of current) {
        try {
          (this.options.signalProcess ?? process.kill)(row.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
  }
  private async alive(): Promise<boolean> {
    const current = await this.census();
    const observed = current.length > 0;
    const group =
      this.child &&
      this.platform !== 'win32' &&
      (this.options.groupAlive ?? processHost().groupAlive)(this.child.pid);
    if (group && this.childExited && !current.some((row) => row.group === this.child?.pid)) {
      // An unseen orphan and a reused group cannot be distinguished safely.
      // Retain the child for retry, but revoke the supervisor's group signal lease.
      this.release?.();
      this.release = undefined;
      throw new Error(
        `hub shutdown: expected verified empty or owned process group ${this.child?.pid} | received nonempty group without a live owned identity`
      );
    }
    return observed || Boolean(group);
  }
  /**
   * Settle owned processes and release their signal lease, then drain stderr before restart.
   * @example await hub.stop();
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try {
      await stopSmokeProcess(
        {
          exited: child.exited,
          get exitCode() {
            return child.exitCode;
          },
          alive: () => this.alive(),
          signal: (signal) => this.signal(signal),
        },
        {
          platform: this.platform,
          graceMs: this.options.budgetMs,
          requireExitZero: this.options.requireExitZero,
        }
      );
    } finally {
      if (this.childExited && !(await this.alive())) {
        this.release?.();
        this.release = undefined;
        await awaitSmokeCompletion(
          this.stderr?.done ?? Promise.resolve(),
          this.options.budgetMs ?? 30_000,
          'process stderr drain'
        );
        this.child = undefined;
      }
    }
  }
}
