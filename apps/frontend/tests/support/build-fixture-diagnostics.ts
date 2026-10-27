interface BuildChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly signalCode: string | number | null;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(): void;
}

/** Safely render observation failures for diagnostics.
 * @example const text = describeFailure(new Error('build failed'));
 */
function describeFailure(error: unknown): string {
  try {
    return String(error);
  } catch {
    return '[unprintable error]';
  }
}

interface Drain {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  done: boolean;
}

/**
 * Emit rollback-fixture progress without allowing diagnostics to change execution.
 * @example const diagnostics = new BuildFixtureDiagnostics('stylesheet failure');
 */
export class BuildFixtureDiagnostics {
  private readonly started: number | undefined;
  private child?: BuildChild;
  private childExited = false;
  private readonly drains: Drain[] = [];
  private tasks: Promise<unknown>[] = [];
  private closing?: Promise<void>;

  constructor(
    private readonly fixture: string,
    private readonly emit: (line: string) => void = console.error,
    private readonly now: () => number = performance.now.bind(performance)
  ) {
    try {
      this.started = now();
    } catch {
      this.started = undefined;
    }
  }

  /** Record a phase immediately, for example `record('fixture:prepared')`. */
  record(phase: string, detail: Record<string, unknown> = {}): void {
    try {
      const elapsedMs = this.started === undefined ? undefined : this.now() - this.started;
      this.emit(
        `[build-fixture] ${JSON.stringify({ fixture: this.fixture, phase, elapsedMs, workerPid: process.pid, platform: process.platform, bun: Bun.version, ...detail })}`
      );
    } catch {
      // Diagnostics must not change fixture execution or cleanup.
    }
  }

  /** Observe exit and both pipes together, for example `await diagnostics.observe(child)`. */
  async observe(child: BuildChild): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.child = child;
    this.record('child:started', { childPid: child.pid });
    const exited = child.exited.then(
      (exitCode) => {
        this.childExited = true;
        this.record('child:exited', { childPid: child.pid, exitCode, signal: child.signalCode });
        return exitCode;
      },
      (error: unknown) => {
        this.record('child:exit-rejected', { childPid: child.pid, error: describeFailure(error) });
        throw error;
      }
    );
    const stdout = this.drain(child.stdout, 'stdout', child.pid);
    const stderr = this.drain(child.stderr, 'stderr', child.pid);
    this.tasks = [exited, stdout, stderr];
    try {
      const [exitCode, output, errors] = await Promise.all([exited, stdout, stderr]);
      this.record('child:observations-complete', { childPid: child.pid });
      return { exitCode, stdout: output, stderr: errors };
    } catch (error) {
      try {
        await this.close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'build observation and cleanup failed');
      }
      throw error;
    }
  }

  /** Stop the retained child and settle its drains, for example `await diagnostics.close()`. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    const failures: unknown[] = [];
    if (this.child && !this.childExited) {
      try {
        this.child.kill();
      } catch (error) {
        failures.push(error);
      }
    }
    const cancellations = this.drains
      .filter((drain) => !drain.done)
      .map(async (drain) => {
        try {
          await drain.reader.cancel();
        } catch (error) {
          failures.push(error);
        }
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.tasks, ...cancellations]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('build child or drains did not settle within 2000 ms')),
            2000
          );
        }),
      ]);
    } catch (error) {
      failures.push(error);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.child && !this.childExited)
      failures.push(new Error('build child exit was not confirmed'));
    if (failures.length) throw new AggregateError(failures, 'build child cleanup failed');
  }

  private async drain(
    stream: ReadableStream<Uint8Array>,
    name: string,
    childPid: number
  ): Promise<string> {
    this.record(`${name}:drain-started`, { childPid });
    const reader = stream.getReader();
    const drain: Drain = { reader, done: false };
    this.drains.push(drain);
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        text += decoder.decode(chunk.value, { stream: true });
        this.record(`${name}:chunk`, { childPid, bytes });
      }
      text += decoder.decode();
      this.record(`${name}:drained`, { childPid, bytes, text });
      return text;
    } catch (error) {
      this.record(`${name}:drain-rejected`, {
        childPid,
        bytes,
        text,
        error: describeFailure(error),
      });
      throw error;
    } finally {
      drain.done = true;
      reader.releaseLock();
    }
  }
}
