// Normalize one line of a Bun run log so a scanner can anchor on Bun's own
// output regardless of who invoked it.
//
// The same suite reaches a log through two shapes. A direct `bun test` writes
// its lines unprefixed; `bun run test` fans out through turbo `--ui=stream`,
// which prefixes every line with `<package>:<task>: `. A scanner that anchors
// on `^` without accounting for the prefix silently matches nothing under one
// of the two callers — and "silently" is the problem, since both consumers
// here (scripts/qa-gate/unhandled-errors.ts, scripts/ci/run-tests-watchdog.ts)
// read a *failure* signal, so a miss reads as green.

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

// The turbo prefix with its task key captured, so a block opened by one lane
// is not closed by another lane's interleaved output.
const TURBO_TASK_RE = /^((?:@[\w/-]+|\/\/):[\w:-]+):\s+/;

export interface LogLine {
  /** Turbo task key (`@mangostudio/api:test`), or `''` for an unprefixed line. */
  readonly taskKey: string;
  /** Bun's own output: ANSI, trailing CR and the turbo prefix removed, trimmed. */
  readonly body: string;
}

/**
 * Split a raw run-log line into its turbo task key and Bun's own output.
 * // Usage: normalizeLogLine('@mangostudio/api:test:  2 fail') // → { taskKey: '@mangostudio/api:test', body: '2 fail' }
 */
export const normalizeLogLine = (rawLine: string): LogLine => {
  const stripped = rawLine.replace(ANSI_RE, '').replace(/\r$/, '');
  const prefix = stripped.match(TURBO_TASK_RE);
  return {
    taskKey: prefix?.[1] ?? '',
    body: (prefix ? stripped.slice(prefix[0].length) : stripped).trim(),
  };
};
