import type { ProcessController } from '../../../src/cli/process-control';

/**
 * In-memory ProcessController for tests: scripted liveness and start times plus
 * recorded terminate/kill calls. No real signals are sent.
 *
 * Every pid it is built with started at epoch 0, so a state file with the default
 * `startedAt: 0` names the hub. `aliveSince` and `hideStartTime` script the two other
 * answers the CLI has to handle: an unrelated process that took the hub's pid, and a
 * platform that cannot say when a process started.
 */
export class FakeProcessController implements ProcessController {
  readonly terminated: number[] = [];
  readonly killed: number[] = [];
  private readonly alive: Set<number>;
  private readonly startTimes = new Map<number, number | undefined>();
  private readonly startTokens = new Map<number, string | undefined>();
  /** How many identity queries ran, so a test can prove a path made none. */
  tokenReads = 0;
  timeReads = 0;

  constructor(alivePids: number[] = []) {
    this.alive = new Set(alivePids);
    for (const pid of alivePids) {
      this.startTimes.set(pid, 0);
      this.startTokens.set(pid, `fake-token-${pid}`);
    }
  }

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  startTimeMs(pid: number): Promise<number | undefined> {
    this.timeReads += 1;
    return Promise.resolve(this.startTimes.get(pid));
  }

  startToken(pid: number): Promise<string | undefined> {
    this.tokenReads += 1;
    return Promise.resolve(this.startTokens.get(pid));
  }

  terminate(pid: number): void {
    this.terminated.push(pid);
  }

  kill(pid: number): void {
    this.killed.push(pid);
  }

  /** Simulate the process exiting (e.g. after a signal). */
  die(pid: number): void {
    this.alive.delete(pid);
    this.startTimes.delete(pid);
    this.startTokens.delete(pid);
  }

  /** `pid` is alive and started at `startedMs`: the hub, or a process that reused its pid. */
  aliveSince(pid: number, startedMs: number): void {
    this.alive.add(pid);
    this.startTimes.set(pid, startedMs);
    if (!this.startTokens.has(pid)) this.startTokens.set(pid, `fake-token-${pid}`);
  }

  /** `pid` is alive but the platform queries for its start time and token fail. */
  hideStartTime(pid: number): void {
    this.alive.add(pid);
    this.startTimes.set(pid, undefined);
    this.startTokens.set(pid, undefined);
  }

  /** The OS now reports `token` for `pid`; `undefined` makes that query fail. */
  startTokenOf(pid: number, token: string | undefined): void {
    this.alive.add(pid);
    this.startTokens.set(pid, token);
  }
}
