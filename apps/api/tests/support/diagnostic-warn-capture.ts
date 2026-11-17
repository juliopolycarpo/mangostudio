/** Named fake for the hub log: collects every structured line written to `console.warn`. */
export class DiagnosticWarnCapture {
  readonly lines: string[] = [];
  private readonly original = console.warn;
  private readonly originalFlag = process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;

  start(): void {
    // The test lanes silence diagnostic logs; this fake needs them on.
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '1';
    console.warn = (...args: unknown[]) => {
      this.lines.push(args.map(String).join(' '));
    };
  }

  stop(): void {
    console.warn = this.original;
    if (this.originalFlag === undefined) delete process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
    else process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = this.originalFlag;
  }

  /** Runs `read` with the capture on and returns the lines it logged. */
  async during(read: () => unknown): Promise<string[]> {
    this.start();
    try {
      await read();
    } finally {
      this.stop();
    }
    return this.lines;
  }
}
