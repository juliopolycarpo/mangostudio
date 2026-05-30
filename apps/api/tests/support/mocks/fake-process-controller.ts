import type { ProcessController } from '../../../src/cli/process-control';

/**
 * In-memory ProcessController for tests: scripted liveness plus recorded
 * terminate/kill calls. No real signals are sent.
 */
export class FakeProcessController implements ProcessController {
  readonly terminated: number[] = [];
  readonly killed: number[] = [];
  private readonly alive: Set<number>;

  constructor(alivePids: number[] = []) {
    this.alive = new Set(alivePids);
  }

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
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
  }
}
