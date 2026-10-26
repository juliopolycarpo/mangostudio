interface BuildChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly signalCode: string | number | null;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
}

/**
 * Emit rollback-fixture progress before assertions or a test deadline can hide it.
 * Observation retains the original child promises and does not control its lifetime.
 *
 * @example
 * const diagnostics = new BuildFixtureDiagnostics('stylesheet failure');
 * diagnostics.record('fixture-copy:start');
 * const result = await diagnostics.observe(child);
 */
export class BuildFixtureDiagnostics {
  private readonly started: number;

  constructor(
    private readonly fixture: string,
    private readonly emit: (line: string) => void = console.error,
    private readonly now: () => number = performance.now.bind(performance)
  ) {
    this.started = now();
  }

  /** Record a phase immediately, for example `record('fixture:prepared')`. */
  record(phase: string, detail: Record<string, unknown> = {}): void {
    this.emit(
      `[build-fixture] ${JSON.stringify({
        fixture: this.fixture,
        phase,
        elapsedMs: this.now() - this.started,
        workerPid: process.pid,
        platform: process.platform,
        bun: Bun.version,
        ...detail,
      })}`
    );
  }

  /** Observe exit and both pipes together, for example `await diagnostics.observe(child)`. */
  async observe(child: BuildChild): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.record('child:started', { childPid: child.pid });
    const exited = child.exited.then(
      (exitCode) => {
        this.record('child:exited', { childPid: child.pid, exitCode, signal: child.signalCode });
        return exitCode;
      },
      (error: unknown) => {
        this.record('child:exit-rejected', { childPid: child.pid, error: String(error) });
        throw error;
      }
    );
    const stdout = this.drain(child.stdout, 'stdout', child.pid);
    const stderr = this.drain(child.stderr, 'stderr', child.pid);
    const [exitCode, output, errors] = await Promise.all([exited, stdout, stderr]);
    this.record('child:observations-complete', { childPid: child.pid });
    return { exitCode, stdout: output, stderr: errors };
  }

  private async drain(
    stream: ReadableStream<Uint8Array>,
    name: string,
    childPid: number
  ): Promise<string> {
    this.record(`${name}:drain-started`, { childPid });
    const reader = stream.getReader();
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
      this.record(`${name}:drain-rejected`, { childPid, bytes, text, error: String(error) });
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}
