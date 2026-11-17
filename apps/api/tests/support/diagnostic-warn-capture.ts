import { expect } from 'bun:test';

/**
 * Asserts the hub log has one `event` line whose metadata carries `fields` and the raw `fragment`.
 *
 * The line is parsed so the fields compare as values; the fragment is compared as JSON encodes it
 * (a Windows path's backslashes are doubled).
 */
export function expectHubLogEntry(
  lines: readonly string[],
  event: string,
  expected: { readonly fields: Readonly<Record<string, unknown>>; readonly fragment: string }
): void {
  const entries = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as { event?: string; metadata?: Record<string, unknown> }];
    } catch {
      return [];
    }
  });
  const entry = entries.find((candidate) => candidate.event === event);
  expect(
    entry,
    `(hub log): expected a "${event}" entry | received: ${lines.join(' ; ') || '(no lines)'}`
  ).toBeDefined();
  const metadata = entry?.metadata ?? {};
  expect(metadata).toMatchObject(expected.fields);
  const text = JSON.stringify(metadata);
  // `text` is JSON, so the fragment is encoded the same way before the comparison.
  const encoded = JSON.stringify(expected.fragment).slice(1, -1);
  expect(
    text.includes(encoded),
    `(hub log): expected "${event}" to carry "${expected.fragment}" | received: ${text}`
  ).toBe(true);
}

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
