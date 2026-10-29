import type { SmokeHubChild, SmokeHubOptions } from '../../lib/binary-smoke-hub';
import type { NativeProcess } from '../../lib/native-bun-qualification-process';

/** Exact fake process handles plus a census containing an unrelated developer process. */
export class FakeSmokeHub {
  readonly events: string[] = [];
  readonly signalled: number[] = [];
  runtimeAlive = true;
  runtimeParent = 900001;
  runtimeIdentity = '900002:2';
  readyFailure = false;
  reusedGroup = false;
  root: SmokeHubChild | undefined;
  private finish: (() => void) | undefined;
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
      },
    };
    this.finish = () => {
      if (root.exitCode !== null) return;
      root.exitCode = 0;
      completion.resolve(0);
      void writer.close();
    };
    this.root = root;
    return root;
  };
  private snapshot = (): Promise<NativeProcess[]> => {
    const rows: NativeProcess[] = [
      { pid: 900003, parentPid: 1, group: 900003, identity: '900003:3', command: 'unrelated' },
    ];
    if (this.root?.exitCode === null)
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
    return Promise.resolve(rows);
  };
  private signalGroup = (pid: number, signal: NodeJS.Signals): void => {
    this.signalled.push(pid);
    this.events.push(signal);
    this.finish?.();
    if (this.mode === 'graceful' || signal === 'SIGKILL') this.runtimeAlive = false;
  };
  private signalProcess = (pid: number): void => {
    this.signalled.push(pid);
    if (pid !== 900002 && pid !== 900001) throw new Error(`unowned fake PID ${pid}`);
    this.runtimeAlive = false;
  };
  /** Inject deterministic processes and transport failures. @example const hub = new SmokeHub(fake.options()); */
  options(): SmokeHubOptions {
    return {
      groupAlive: () => false,
      spawn: this.spawn,
      snapshot: this.snapshot,
      signalGroup: this.signalGroup,
      signalProcess: this.signalProcess,
      budgetMs: 20,
      platform: 'linux',
      ready: () => {
        this.events.push('ready');
        return this.readyFailure
          ? Promise.reject(new Error('readiness failed'))
          : Promise.resolve();
      },
    };
  }
}
