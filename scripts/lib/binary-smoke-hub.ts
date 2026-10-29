import { readLinuxSmokeProcesses } from './binary-smoke-linux';
import { awaitSmokeCompletion, stopSmokeProcess } from './binary-smoke-process';
import { pumpStream } from './child-streams';
import {
  type NativeProcess,
  scopeNativeProcesses,
  snapshotNativeProcesses,
} from './native-bun-qualification-process';
import { ChildSupervisor, processHost } from './process-tree';

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
}

/**
 * Own artifact process lifetimes and the exact descendant identities observed before shutdown.
 * A failed start remains owned until stop; callers must use finally even when readiness fails.
 * @example const hub = new SmokeHub(options); try { await hub.start(); } finally { await hub.stop(); }
 */
export class SmokeHub {
  private child: SmokeHubChild | undefined;
  private stderr: ReturnType<typeof pumpStream> | undefined;
  private owned: NativeProcess[] = [];
  private rootIdentity: string | null = null;
  private release: (() => void) | undefined;
  private readonly supervisor = new ChildSupervisor(processHost());
  private readonly platform: NodeJS.Platform;
  private readonly snapshot: () => Promise<NativeProcess[]>;
  constructor(private readonly options: SmokeHubOptions) {
    this.platform = options.platform ?? process.platform;
    this.snapshot =
      options.snapshot ??
      (this.platform === 'linux'
        ? () =>
            readLinuxSmokeProcesses([
              ...(this.child && (this.child.exitCode === null || this.rootIdentity)
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
    const child = this.options.spawn();
    this.child = child;
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
      rootAlive: this.child.exitCode === null,
      rootIdentity: this.rootIdentity,
      observed: this.owned,
    });
    this.rootIdentity = scoped.rootIdentity;
    this.owned = scoped.observed;
    return scoped.current;
  }
  /** Record the runtime's identity before disconnect/shutdown can reparent it. @example await hub.observeRuntime(); */
  async observeRuntime(): Promise<void> {
    const current = await this.census();
    if (!current.some((row) => row.pid !== this.child?.pid))
      throw new Error('Local runtime: expected an owned runtime child process');
  }
  /** Await only recorded descendants, never unrelated processes. @example await hub.waitForRuntimeExit(); */
  async waitForRuntimeExit(): Promise<void> {
    const expected = new Set(
      this.owned.filter((row) => row.pid !== this.child?.pid).map((row) => row.identity)
    );
    const budgetMs = this.options.budgetMs ?? 30_000;
    const deadline = performance.now() + budgetMs;
    do {
      if (!(await this.snapshot()).some((row) => expected.has(row.identity))) return;
      await Bun.sleep(10);
    } while (performance.now() < deadline);
    throw new Error(
      `Local runtime: expected disconnected child processes to exit within ${budgetMs}ms`
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
    const ownsGroup = child.exitCode === null || current.some((row) => row.group === child.pid);
    if (this.platform !== 'win32' && ownsGroup) {
      try {
        (this.options.signalGroup ?? process.kill)(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    } else if (child.exitCode === null) child.kill(signal);
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
      (this.child.exitCode === null || current.some((row) => row.group === this.child?.pid)) &&
      (this.options.groupAlive ?? processHost().groupAlive)(this.child.pid);
    return observed || Boolean(group);
  }
  /** Stop, await exit and drain stderr before releasing ownership. @example await hub.stop(); */
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
      if (child.exitCode !== null && !(await this.alive())) {
        this.release?.();
        this.child = undefined;
        await awaitSmokeCompletion(
          this.stderr?.done ?? Promise.resolve(),
          this.options.budgetMs ?? 30_000,
          'process stderr drain'
        );
      }
    }
  }
}
