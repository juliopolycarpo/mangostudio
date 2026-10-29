import type { SmokeHubChild, SmokeHubOptions } from '../../lib/binary-smoke-hub';
import type { NativeProcess } from '../../lib/native-bun-qualification-process';
import type { CancelSignal, SupervisorHost } from '../../lib/process-tree';

/** Named cancellation host for the real supervisor. @example fake.supervisorHost.deliver('SIGTERM'); */
class FakeSmokeSupervisorHost implements SupervisorHost {
  readonly graceMs = 0;
  readonly groupKills: Array<[number, NodeJS.Signals]> = [];
  readonly exitStatuses: number[] = [];
  readonly liveGroups = new Set<number>();
  private readonly signals = new Map<CancelSignal, () => void>();
  private readonly exits = new Set<() => void>();
  private clock = 0;
  get handlersInstalled(): number {
    return this.signals.size + this.exits.size;
  }
  onSignal(name: CancelSignal, handler: () => void): () => void {
    this.signals.set(name, handler);
    return () => this.signals.delete(name);
  }
  onExit(handler: () => void): () => void {
    this.exits.add(handler);
    return () => this.exits.delete(handler);
  }
  killGroup(pid: number, signal: NodeJS.Signals): void {
    this.groupKills.push([pid, signal]);
    if (signal === 'SIGKILL') this.liveGroups.delete(pid);
  }
  groupAlive(pid: number): boolean {
    return this.liveGroups.has(pid);
  }
  stdinIsTerminal(): boolean {
    return false;
  }
  exit(status: number): never {
    this.exitStatuses.push(status);
    return undefined as never;
  }
  sleep(ms: number): Promise<void> {
    this.clock += ms;
    return Promise.resolve();
  }
  now(): number {
    return this.clock;
  }
  report(_message: string): void {}
  /** Deliver a runner cancellation through installed handlers. @example host.deliver('SIGTERM'); */
  deliver(signal: CancelSignal): void {
    this.signals.get(signal)?.();
  }
  /** Deliver the runner's own exit hook. @example host.endProcess(); */
  endProcess(): void {
    for (const handler of this.exits) handler();
  }
}

/** Exact fake process handles plus a census containing an unrelated developer process. */
export class FakeSmokeHub {
  readonly events: string[] = [];
  readonly signalled: number[] = [];
  readonly supervisorHost = new FakeSmokeSupervisorHost();
  runtimeAlive = false;
  runtimeConsoleAlive = false;
  warmupAlive = false;
  warmupConsoleAlive = false;
  runtimeParent = 900001;
  runtimeIdentity = '900002:20';
  readyFailure = false;
  snapshotFailure = false;
  nullExitCodeOnSignal = false;
  holdStderr = false;
  reusedGroup = false;
  groupStillAlive = false;
  root: SmokeHubChild | undefined;
  private finish: (() => void) | undefined;
  private finishStderr: (() => void) | undefined;
  private rootAlive = false;
  private generation = 0;
  constructor(readonly mode: 'graceful' | 'leaked' = 'graceful') {}
  private spawn = (): SmokeHubChild => {
    this.generation += 1;
    this.events.push('spawn');
    const completion = Promise.withResolvers<number>();
    const stderr = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stderr.writable.getWriter();
    void writer.write(new TextEncoder().encode('fake stderr'));
    const root = {
      pid: 900001,
      exitCode: null as number | null,
      exited: completion.promise,
      stderr: stderr.readable,
      kill: (signal: NodeJS.Signals) => {
        this.events.push(signal);
        this.finish?.();
        this.finishChildren(signal);
      },
    };
    this.finish = () => {
      if (!this.rootAlive) return;
      this.rootAlive = false;
      root.exitCode = this.nullExitCodeOnSignal ? null : 0;
      completion.resolve(this.nullExitCodeOnSignal ? 143 : 0);
      if (!this.holdStderr) this.finishStderr?.();
    };
    this.finishStderr = () => void writer.close();
    this.root = root;
    this.rootAlive = true;
    return root;
  };
  private snapshot = (): Promise<NativeProcess[]> => {
    if (this.snapshotFailure) return Promise.reject(new Error('incomplete fake process census'));
    const rows: NativeProcess[] = [
      { pid: 900003, parentPid: 1, group: 900003, identity: '900003:3', command: 'unrelated' },
    ];
    if (this.root && this.rootAlive)
      rows.push({
        pid: this.root.pid,
        parentPid: process.pid,
        group: this.root.pid,
        identity: `900001:${this.generation}`,
        command: 'hub',
      });
    if (this.reusedGroup)
      rows.push({
        pid: 900001,
        parentPid: 1,
        group: 900001,
        identity: '900001:999',
        command: 'unrelated reused group',
      });
    if (this.runtimeAlive)
      rows.push({
        pid: 900002,
        parentPid: this.runtimeParent,
        group: this.runtimeParent,
        identity: this.runtimeIdentity,
        command: 'runtime',
      });
    if (this.runtimeConsoleAlive)
      rows.push({
        pid: 900004,
        parentPid: 900002,
        group: 900001,
        identity: '900004:21',
        command: 'runtime conhost',
      });
    if (this.warmupAlive)
      rows.push({
        pid: 900010,
        parentPid: 900001,
        group: 900001,
        identity: '900010:10',
        command: 'warmup runtime',
      });
    if (this.warmupConsoleAlive)
      rows.push({
        pid: 900011,
        parentPid: 900010,
        group: 900001,
        identity: '900011:11',
        command: 'warmup conhost',
      });
    return Promise.resolve(rows);
  };
  private finishChildren(signal: NodeJS.Signals): void {
    if (this.mode !== 'graceful' && signal !== 'SIGKILL') return;
    this.runtimeAlive = false;
    this.runtimeConsoleAlive = false;
    this.warmupAlive = false;
    this.warmupConsoleAlive = false;
  }
  private signalGroup = (pid: number, signal: NodeJS.Signals): void => {
    this.signalled.push(pid);
    this.events.push(signal);
    this.finish?.();
    this.finishChildren(signal);
  };
  private signalProcess = (pid: number): void => {
    this.signalled.push(pid);
    if (![900001, 900002, 900004, 900010, 900011].includes(pid))
      throw new Error(`unowned fake PID ${pid}`);
    if (pid === 900002) this.runtimeAlive = false;
    if (pid === 900004) this.runtimeConsoleAlive = false;
    if (pid === 900010) this.warmupAlive = false;
    if (pid === 900011) this.warmupConsoleAlive = false;
  };
  /** Settle an inherited stderr pipe after its parent exited. @example fake.closeStderr(); */
  closeStderr(): void {
    this.holdStderr = false;
    this.finishStderr?.();
  }
  /** Inject deterministic processes and transport failures. @example const hub = new SmokeHub(fake.options()); */
  options(): SmokeHubOptions {
    return {
      groupAlive: () => this.groupStillAlive,
      spawn: this.spawn,
      snapshot: this.snapshot,
      signalGroup: this.signalGroup,
      signalProcess: this.signalProcess,
      budgetMs: 20,
      platform: 'linux',
      supervisorHost: this.supervisorHost,
      ready: () => {
        this.events.push('ready');
        return this.readyFailure
          ? Promise.reject(new Error('readiness failed'))
          : Promise.resolve();
      },
    };
  }
}
