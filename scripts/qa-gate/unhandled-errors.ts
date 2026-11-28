// Extract unhandled-error counts and headlines from a run log — the one test
// signal JUnit cannot carry.
//
// Measured on Bun 1.4.0-canary.1, re-verified on 1.4.2: an error raised between tests prints a
// `# Unhandled error between tests` block and a ` N error` summary line, exits
// 1, and leaves the JUnit report reading `failures="0"` with no failing
// `<testcase>`. So the signal has to come from the log — without it the QA
// fragment degrades to `parseMiss` and loses the headline naming the leak.
//
// Everything else the old log parser did — pass, fail and skip counts — now
// comes from ./junit-results.ts.
//
// A missing log is not "no errors": a shard that died before the runner wrote
// its log has an unknown count. The CLI therefore exits 1 naming the path
// instead of printing zero, and the merge treats an absent or malformed
// `errors.json` as unknown (see `readUnhandledErrorsFile`).
//
// Usage: bun ./scripts/qa-gate/unhandled-errors.ts <run.log> > errors.json

import {
  isInlineFailure,
  isUnhandledErrorHeading,
  normalizeLogLine,
  unhandledErrorCount,
} from '../lib/log-lines';
import type { TestErrorHeadline } from './collect/types';

// `bun test`: a block heading, then the offending source and an
// `error: <message>` headline, then the run summary's ` N error` line. The
// heading and count shapes come from ../lib/log-lines.
const BUN_HEADLINE_RE = /^error:\s+(.+)$/;
const BUN_PASS_RE = /^(\d+)\s+pass$/;

const MAX_HEADLINES = 5;
const MAX_HEADLINE_CHARS = 400;

export interface UnhandledErrors {
  /** Total unhandled errors the run reported; 0 when it printed none. */
  readonly errors: number;
  readonly headlines: readonly TestErrorHeadline[];
}

const clip = (text: string): string =>
  text.length <= MAX_HEADLINE_CHARS ? text : `${text.slice(0, MAX_HEADLINE_CHARS - 1)}…`;

/**
 * Parse a run log for unhandled-error counts and headlines.
 * // Usage: parseUnhandledErrors(await Bun.file('run.log').text());
 */
export const parseUnhandledErrors = (text: string): UnhandledErrors => {
  let errors = 0;
  const headlines: TestErrorHeadline[] = [];
  // Turbo task keys with an unhandled-error block still open.
  const bunBlockOpen = new Set<string>();

  const push = (message: string): void => {
    if (headlines.length >= MAX_HEADLINES) return;
    headlines.push({ message: clip(message.trim()), originatedIn: null });
  };

  for (const rawLine of text.split('\n')) {
    const { taskKey, body } = normalizeLogLine(rawLine);
    if (body.startsWith('##[')) continue;

    if (isUnhandledErrorHeading(body)) {
      bunBlockOpen.add(taskKey);
      continue;
    }

    if (bunBlockOpen.has(taskKey)) {
      const bunHeadline = body.match(BUN_HEADLINE_RE);
      if (bunHeadline) {
        push(`error: ${bunHeadline[1]}`);
        bunBlockOpen.delete(taskKey);
        continue;
      }
      // The block ended without a headline (source frames only): stop looking
      // once the runner is back to reporting tests.
      if (body.startsWith('(pass)') || isInlineFailure(body) || BUN_PASS_RE.test(body)) {
        bunBlockOpen.delete(taskKey);
      }
    }

    errors += unhandledErrorCount(body) ?? 0;
  }

  return { errors, headlines };
};

/** What `errors.json` must look like, quoted by every failure about one. */
const UNHANDLED_ERRORS_SHAPE =
  '{"errors": <integer >= 0>, "headlines": [{"message": <string>, "originatedIn": <string|null>}]}';

const isHeadline = (value: unknown): value is TestErrorHeadline =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as TestErrorHeadline).message === 'string' &&
  ((value as TestErrorHeadline).originatedIn === null ||
    typeof (value as TestErrorHeadline).originatedIn === 'string');

/** Whether a parsed value has the shape `parseUnhandledErrors` produces. */
export const isUnhandledErrors = (value: unknown): value is UnhandledErrors =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Number.isSafeInteger((value as UnhandledErrors).errors) &&
  (value as UnhandledErrors).errors >= 0 &&
  Array.isArray((value as UnhandledErrors).headlines) &&
  (value as UnhandledErrors).headlines.every(isHeadline);

/** A shard's unhandled-error count, or the reason it cannot be known. */
export type UnhandledErrorsRead =
  | { readonly kind: 'read'; readonly value: UnhandledErrors }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Read one shard's `errors.json` text. `null` means the file does not exist;
 * an empty file is what a failed `> errors.json` redirect leaves behind. Both,
 * and anything that is not the extractor's shape, are unknown rather than zero.
 * // Usage: readUnhandledErrorsFile('shards/test-shard-1/unhandled-errors.json', text)
 */
export const readUnhandledErrorsFile = (path: string, text: string | null): UnhandledErrorsRead => {
  const unavailable = (received: string): UnhandledErrorsRead => ({
    kind: 'unavailable',
    reason: `${path}: expected ${UNHANDLED_ERRORS_SHAPE} | received: ${received}`,
  });
  if (text === null) return unavailable('no such file');
  if (text.trim() === '') return unavailable('an empty file');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unavailable(`invalid JSON ${JSON.stringify(text.slice(0, 80))}`);
  }
  return isUnhandledErrors(parsed)
    ? { kind: 'read', value: parsed }
    : unavailable(JSON.stringify(parsed)?.slice(0, 80) ?? String(parsed));
};

/** Union several logs' findings, keeping at most `MAX_HEADLINES` headlines. */
export const mergeUnhandledErrors = (parts: readonly UnhandledErrors[]): UnhandledErrors => ({
  errors: parts.reduce((sum, part) => sum + part.errors, 0),
  headlines: parts.flatMap((part) => part.headlines).slice(0, MAX_HEADLINES),
});

if (import.meta.main) {
  const [, , logPath] = process.argv;
  if (!logPath) {
    process.stderr.write(
      'Usage: bun ./scripts/qa-gate/unhandled-errors.ts <run.log> > errors.json\n'
    );
    process.exit(1);
  }
  const file = Bun.file(logPath);
  if (!(await file.exists())) {
    process.stderr.write(
      `unhandled-errors: expected a run log at ${logPath} | received: no such file; ` +
        'the run likely ended before it wrote one, so its unhandled-error count is unknown, not 0.\n'
    );
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(parseUnhandledErrors(await file.text()))}\n`);
}
