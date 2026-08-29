// Extract unhandled-error counts and headlines from a run log — the one test
// signal JUnit cannot carry.
//
// Measured on Bun 1.4.0-canary.1: an error raised between tests prints a
// `# Unhandled error between tests` block and a ` N error` summary line, exits
// 1, and leaves the JUnit report reading `failures="0"` with no failing
// `<testcase>`. So the signal has to come from the log — without it the QA
// fragment degrades to `parseMiss` and loses the headline naming the leak.
//
// Everything else the old log parser did — pass, fail and skip counts — now
// comes from ./junit-results.ts.
//
// Usage: bun ./scripts/qa-gate/unhandled-errors.ts <run.log> > errors.json

import { normalizeLogLine } from '../lib/log-lines';
import type { TestErrorHeadline } from './collect/types';

// `bun test`: a block heading, then the offending source and an
// `error: <message>` headline, then the run summary's ` N error` line.
const BUN_UNHANDLED_HEADING = '# Unhandled error between tests';
const BUN_HEADLINE_RE = /^error:\s+(.+)$/;
const BUN_ERROR_COUNT_RE = /^(\d+)\s+errors?$/;
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

    if (body === BUN_UNHANDLED_HEADING) {
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
      if (body.startsWith('(pass)') || body.startsWith('(fail)') || BUN_PASS_RE.test(body)) {
        bunBlockOpen.delete(taskKey);
      }
    }

    const bunErrorCount = body.match(BUN_ERROR_COUNT_RE);
    if (bunErrorCount) errors += Number(bunErrorCount[1]);
  }

  return { errors, headlines };
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
  const parsed = (await file.exists())
    ? parseUnhandledErrors(await file.text())
    : { errors: 0, headlines: [] };
  process.stdout.write(`${JSON.stringify(parsed)}\n`);
}
