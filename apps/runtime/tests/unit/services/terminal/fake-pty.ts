import type { PtyHandle, PtyPort, PtySpawnInput } from '../../../../src/services/terminal/pty';

/** One spawned handle: records what the session sent it, and lets a test drive it. */
export class FakePtyHandle implements PtyHandle {
  readonly writes: Uint8Array[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  closeCalls = 0;
  #closeError: Error | undefined;

  constructor(
    readonly pid: number,
    private readonly input: PtySpawnInput
  ) {}

  write(data: Uint8Array): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  close(): void {
    this.closeCalls += 1;
    if (this.#closeError) throw this.#closeError;
  }

  /** Test control: makes the next `close()` throw instead of succeeding. */
  throwOnClose(error: Error): void {
    this.#closeError = error;
  }

  /** Test control: deliver a chunk as if the child had written it. */
  emitData(chunk: Uint8Array): void {
    this.input.onData(chunk);
  }

  /** Test control: end the process. */
  emitExit(exitCode: number | null, signal: string | null): void {
    this.input.onExit(exitCode, signal);
  }
}

/** Records every spawn so a test can reach the handle it produced. */
export class FakePtyPort implements PtyPort {
  readonly handles: FakePtyHandle[] = [];
  readonly spawnInputs: PtySpawnInput[] = [];
  #nextPid = 1000;

  spawn(input: PtySpawnInput): PtyHandle {
    this.spawnInputs.push(input);
    const handle = new FakePtyHandle(this.#nextPid++, input);
    this.handles.push(handle);
    return handle;
  }
}
