import type { DetachDeps, DetachOptions } from '../../../src/cli/detach';
import { CliError } from '../../../src/cli/errors';
import type { RestartTargetProcess } from '../../../src/cli/restart-detached';
import type { ServerState } from '../../../src/lib/server-state';
import { FakeProcessController } from './fake-process-controller';

export const PREVIOUS_VERSION = '0.1.1';
export const UPGRADED_VERSION = '0.1.2';
export const PREVIOUS_HUB_PID = 42;

const SUCCESSOR_BOOT_MS = 250;

interface PlacedBinary {
  readonly version: string;
  /** The path is a launcher that runs the binary as a child instead of becoming it. */
  readonly supervisesBinary: boolean;
  /** `<path> --version` exits non-zero. */
  readonly broken: boolean;
}

export interface PlaceOptions {
  readonly supervisesBinary?: boolean;
  readonly broken?: boolean;
}

/**
 * The disk, process table and state file of a machine whose package manager
 * just replaced the hub's install while the old hub (pid 42, build 0.1.1) is
 * still running. Tests lay out what the manager left behind with `place` and
 * `remove`, then let the real restart code spawn through it: a spawned path
 * resolves to whatever version is placed there, a launcher that supervises
 * hands back its own pid, and the hub it starts writes its own.
 *
 * No manager runs; only the paths a manager would have left exist.
 */
export class FakeUpgradedInstall {
  readonly controller = new FakeProcessController([PREVIOUS_HUB_PID]);
  readonly stoppedPids: number[] = [];
  readonly spawnedArgv: (readonly string[])[] = [];
  readonly versionProbes: (readonly string[])[] = [];
  private readonly binaries = new Map<string, PlacedBinary>();
  private state: ServerState | null;
  private clock = 1_700_000_000_000;
  private nextPid = 5_000;

  constructor(private readonly selfExecPath: string) {
    this.state = {
      pid: PREVIOUS_HUB_PID,
      port: 3001,
      host: 'localhost',
      startedAt: this.clock - 60_000,
      logFile: 'server.log',
      version: PREVIOUS_VERSION,
    };
  }

  /** The old hub's state file, as the restart reads it before stopping it. */
  get previousHub(): ServerState {
    if (!this.state) throw new Error('previous hub state was already removed');
    return this.state;
  }

  place(path: string, version: string, options: PlaceOptions = {}): this {
    this.binaries.set(path, {
      version,
      supervisesBinary: options.supervisesBinary ?? false,
      broken: options.broken ?? false,
    });
    return this;
  }

  remove(path: string): this {
    this.binaries.delete(path);
    return this;
  }

  readonly pathExists = (path: string): boolean => this.binaries.has(path);

  /** The version of the hub the state file names now, or null when no hub is up. */
  runningVersion(): string | null {
    return this.state?.version ?? null;
  }

  runningPid(): number | null {
    return this.state?.pid ?? null;
  }

  isAlive(pid: number): boolean {
    return this.controller.isAlive(pid);
  }

  /** What a graceful stop of the old hub does: it exits and removes its state file. */
  readonly stop = (): Promise<void> => {
    this.stoppedPids.push(PREVIOUS_HUB_PID);
    this.controller.die(PREVIOUS_HUB_PID);
    this.state = null;
    return Promise.resolve();
  };

  /** The `DetachDeps` the restart's `spawnDetached` runs against. */
  detachDeps(): Partial<DetachDeps> {
    return {
      controller: this.controller,
      now: () => this.clock,
      sleep: (ms) => {
        this.clock += ms;
        return Promise.resolve();
      },
      spawn: (port, host, _logFile, options) => this.spawnServe(port, host, options),
      readState: () => Promise.resolve(this.state),
      confirmsHealthy: () => Promise.resolve(true),
    };
  }

  /** The `--version` probe's spawn: what `<path> --version` would print or fail with. */
  readonly spawnTarget = (argv: readonly string[]): RestartTargetProcess => {
    this.versionProbes.push(argv);
    const binary = this.binaries.get(argv[0] ?? '');
    if (!binary) throw new Error(`spawn ${argv[0]} ENOENT`);
    const output = binary.broken ? '' : `${binary.version}\n`;
    return {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(output));
          controller.close();
        },
      }),
      exited: Promise.resolve(binary.broken ? 1 : 0),
      kill: () => undefined,
    };
  };

  private spawnServe(port: number, host: string, options: DetachOptions): number {
    const argv = options.executable ?? [this.selfExecPath];
    this.spawnedArgv.push(argv);
    const binary = this.binaries.get(argv[0] ?? '');
    if (!binary) throw new CliError(`spawn ${argv[0]} ENOENT`);

    const spawnedPid = this.nextPid++;
    this.controller.aliveSince(spawnedPid, this.clock);
    const hubPid = binary.supervisesBinary ? this.nextPid++ : spawnedPid;
    if (hubPid !== spawnedPid) this.controller.aliveSince(hubPid, this.clock);
    // The hub stamps its state file once it is up; the predecessor's has been
    // removed by its own shutdown (or `stop`) before a successor is spawned.
    this.state = {
      pid: hubPid,
      port,
      host,
      startedAt: this.clock + SUCCESSOR_BOOT_MS,
      logFile: 'server.log',
      version: binary.version,
    };
    return spawnedPid;
  }
}
