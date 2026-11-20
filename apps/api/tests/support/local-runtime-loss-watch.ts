/**
 * Says why a test's Local runtime connection ended.
 *
 * A hub that lets go of a runtime and a runtime that dies both reach a caller
 * as `Request "x" cannot complete: the session is closed (closed with 4000)`,
 * with no reason and no stderr. The hub does log the difference
 * (`child_ended`, `connection_lost`, `attestation_withdrawn`), but the test
 * lanes silence diagnostic logs and CI keeps no copy. A test that holds a
 * Local connection starts a watch in `beforeAll` and puts `explain()` in its
 * assertion messages, or runs the risky call through `explaining()`.
 */

/** The hub log events that account for a Local runtime connection ending. */
const LOSS_EVENTS: readonly string[] = ['child_ended', 'connection_lost', 'attestation_withdrawn'];

interface LossLogLine {
  readonly scope?: string;
  readonly event?: string;
  readonly metadata?: Record<string, unknown>;
}

function parseLossLine(line: string): LossLogLine | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const entry = parsed as LossLogLine;
    return entry.event !== undefined && LOSS_EVENTS.includes(entry.event) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the hub's runtime-loss log lines for the span between `start()` and `stop()`. */
export class LocalRuntimeLossWatch {
  readonly #lines: string[] = [];
  readonly #originalWarn = console.warn;
  readonly #originalFlag = process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    // The lanes set the flag to `0`; the events are only written when it is on.
    process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = '1';
    const silenced = this.#originalFlag === '0';
    console.warn = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (parseLossLine(line) !== undefined) {
        this.#lines.push(line);
        return;
      }
      // Turning the logs on must not make every other warning appear in a lane
      // that had asked for silence.
      if (!silenced) this.#originalWarn(...args);
    };
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    console.warn = this.#originalWarn;
    if (this.#originalFlag === undefined) delete process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS;
    else process.env.MANGOSTUDIO_DIAGNOSTIC_LOGS = this.#originalFlag;
  }

  /** The recorded loss events, one per line, or a sentence saying none was logged. */
  explain(): string {
    if (this.#lines.length === 0) {
      return '(local runtime): no child_ended, connection_lost or attestation_withdrawn event was logged since the watch started';
    }
    return `(local runtime): ${this.#lines.join(' ; ')}`;
  }

  /**
   * Runs `run` and, when it rejects, rethrows with {@link explain} appended.
   * The original error is kept as `cause`.
   */
  async explaining<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error(`${message} | ${this.explain()}`, { cause: error });
    }
  }
}
