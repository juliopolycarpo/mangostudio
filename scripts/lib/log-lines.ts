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

// Bun's failure shapes, declared once. Each takes a `LogLine.body`, never a raw
// line: the heading and count shapes are anchored end to end, which only holds
// after `normalizeLogLine` has removed the turbo prefix, ANSI and the CR.
//
// A reporter change has to be tracked here and nowhere else. The two consumers
// (the watchdog's retry scan and the qa-gate parser) used to carry their own
// copies, and the copies drifted: a `\b`-tailed count regex in one matched the
// ordinary line `1 error: Cannot find module 'left-pad'` that the `$`-anchored
// one in the other rightly ignored.

/** Heading Bun prints above an error raised between tests. */
const BUN_UNHANDLED_HEADING = '# Unhandled error between tests';

const ERROR_COUNT_RE = /^(\d+)\s+errors?$/;
const FAIL_COUNT_RE = /^(\d+)\s+fail$/;

/**
 * Whether `body` opens an unhandled-error block.
 * // Usage: isUnhandledErrorHeading('# Unhandled error between tests') // → true
 */
export const isUnhandledErrorHeading = (body: string): boolean => body === BUN_UNHANDLED_HEADING;

/**
 * The count of Bun's run-summary error line (` 1 error`, ` 2 errors`), or null
 * for any other line. Anchored to the whole body: `1 error: <message>` is a log
 * line that merely starts with a number, not a summary. Bun omits the line on a
 * clean run, but the count is returned as-is so a caller decides what zero means.
 * // Usage: unhandledErrorCount('2 errors') // → 2
 */
export const unhandledErrorCount = (body: string): number | null => {
  const match = ERROR_COUNT_RE.exec(body);
  return match ? Number(match[1]) : null;
};

/**
 * The count of Bun's run-summary fail line (` 2 fail`), or null for any other
 * line. A clean run prints ` 0 fail`, so zero is a real answer, not a miss.
 * // Usage: failSummaryCount('0 fail') // → 0
 */
export const failSummaryCount = (body: string): number | null => {
  const match = FAIL_COUNT_RE.exec(body);
  return match ? Number(match[1]) : null;
};

/**
 * Whether `body` is the inline report of a failing test, printed the moment it
 * fails: `(fail) suite > name [0.37ms]`.
 * // Usage: isInlineFailure('(fail) a > b [0.37ms]') // → true
 */
export const isInlineFailure = (body: string): boolean => body.startsWith('(fail)');
