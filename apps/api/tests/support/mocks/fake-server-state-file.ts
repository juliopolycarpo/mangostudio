import type { ServerState } from '../../../src/lib/server-state';

/**
 * In-memory stand-in for `~/.mango/run/server.json`: `readState` and
 * `removeState` have the shape the CLI commands inject, and `present` says
 * whether the file would still be on disk. No file is touched.
 */
export class FakeServerStateFile {
  private state: ServerState | null;

  constructor(state: ServerState | null) {
    this.state = state;
  }

  get present(): boolean {
    return this.state !== null;
  }

  /** Pid the file names now, or null when it is gone. */
  get pid(): number | null {
    return this.state?.pid ?? null;
  }

  /** Simulate a successor hub writing its own state over the file. */
  write(state: ServerState): void {
    this.state = state;
  }

  readonly readState = (): Promise<ServerState | null> => Promise.resolve(this.state);

  readonly removeState = (): Promise<void> => {
    this.state = null;
    return Promise.resolve();
  };
}
