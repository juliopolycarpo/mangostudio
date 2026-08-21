// Extract unhandled-error counts and headlines from a run log — the one test
// signal JUnit cannot carry, for either runner.
//
// Vitest: its JUnit reporter is `onTestRunEnd(testModules)`, so it never
// receives the run's `unhandledErrors` and writes `errors="0"` unconditionally;
// its JSON reporter takes the same argument. The failure mode
// `docs/reference/testing.md` documents under "Unhandled Errors With Green Test
// Counts" (every file green, an `Errors N errors` line, exit 1) is therefore
// invisible in structured output.
//
// Bun: measured on 1.4.0-canary.1, an error raised between tests prints a
// `# Unhandled error between tests` block and a ` N error` summary line, exits
// 1, and leaves the JUnit report reading `failures="0"` with no failing
// `<testcase>`. Same shape, same reason it has to come from the log — without
// it the QA fragment degrades to `parseMiss` and loses the headline naming the
// leak.
//
// Everything else the old log parser did — pass, fail and skip counts for both
// runners — now comes from ./junit-results.ts.
//
// Usage: bun ./scripts/qa-gate/unhandled-errors.ts <run.log> > errors.json

import type { TestErrorHeadline } from './collect/types';

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

// Turbo `--ui=stream` prefixes lines with `<package>:<task>: `. Shard jobs run
// the lanes through Turbo, so the prefix is present there and absent in the
// merge job's direct Vitest invocation; tolerate both.
const TURBO_PREFIX_RE = /^(?:@[\w/-]+|\/\/):[\w:-]+:\s+/;
// The same prefix, captured, so a Bun block opened by one lane is not closed by
// another lane's interleaved output.
const TURBO_TASK_RE = /^((?:@[\w/-]+|\/\/):[\w:-]+):\s+/;

// Vitest default reporter (padSummaryTitle + getStateString).
const VITEST_ERRORS_RE = /\bErrors\s+(\d+)\s+errors?\b/;
const VITEST_ORIGINATED_RE = /This error originated in "([^"]+)" test file\./;
const VITEST_HEADLINE_RE =
  /^(?:Unhandled Rejection:\s+)?((?:[A-Za-z]+)?Error|AggregateError):(?:\s+.*)?$/;

// Bun (`bun test`): a block heading, then the offending source and an
// `error: <message>` headline, then the run summary's ` N error` line.
const BUN_UNHANDLED_HEADING = '# Unhandled error between tests';
const BUN_HEADLINE_RE = /^error:\s+(.+)$/;
const BUN_ERROR_COUNT_RE = /^(\d+)\s+errors?$/;
const BUN_PASS_RE = /^(\d+)\s+pass$/;

const MAX_HEADLINES = 5;
const MAX_HEADLINE_CHARS = 400;

export interface UnhandledErrors {
  /** Total unhandled errors both runners reported; 0 when neither printed one. */
  readonly errors: number;
  readonly headlines: readonly TestErrorHeadline[];
}

const clip = (text: string): string =>
  text.length <= MAX_HEADLINE_CHARS ? text : `${text.slice(0, MAX_HEADLINE_CHARS - 1)}…`;

/**
 * Parse a run log for both runners' unhandled-error counts and headlines.
 * // Usage: parseUnhandledErrors(await Bun.file('run.log').text());
 */
export const parseUnhandledErrors = (text: string): UnhandledErrors => {
  let errors = 0;
  const headlines: TestErrorHeadline[] = [];
  const seen = new Set<string>();
  // Turbo task keys with a Bun unhandled-error block still open.
  const bunBlockOpen = new Set<string>();

  const push = (message: string): void => {
    if (headlines.length >= MAX_HEADLINES) return;
    headlines.push({ message: clip(message.trim()), originatedIn: null });
  };

  // The originated-in line follows its headline, so it back-fills the most
  // recent one. A repeat of the same message under a different file is a
  // different error; dedupe only once the file is known.
  const assignOrigin = (originatedIn: string): void => {
    const last = headlines.at(-1);
    if (!last || last.originatedIn !== null) return;
    const origin = clip(originatedIn);
    const key = `${last.message}\0${origin}`;
    if (seen.has(key)) {
      headlines.pop();
      return;
    }
    seen.add(key);
    headlines[headlines.length - 1] = { ...last, originatedIn: origin };
  };

  for (const rawLine of text.split('\n')) {
    const stripped = rawLine.replace(ANSI_RE, '').replace(/\r$/, '');
    if (stripped.startsWith('##[')) continue;
    const taskKey = stripped.match(TURBO_TASK_RE)?.[1] ?? '';
    const body = stripped.replace(TURBO_PREFIX_RE, '').trim();

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

    const originated = stripped.match(VITEST_ORIGINATED_RE);
    if (originated) {
      assignOrigin(originated[1]);
      continue;
    }

    if (VITEST_HEADLINE_RE.test(body)) {
      push(body);
      continue;
    }

    const vitestErrorCount = stripped.match(VITEST_ERRORS_RE);
    if (vitestErrorCount) {
      errors += Number(vitestErrorCount[1]);
      continue;
    }

    // Bun's summary line is a bare ` N error`. Vitest's is `Errors N errors`,
    // already consumed above, but guard anyway so a stray prefix cannot make
    // one line count twice.
    const bunErrorCount = body.match(BUN_ERROR_COUNT_RE);
    if (bunErrorCount && !/\bErrors\s/.test(stripped)) errors += Number(bunErrorCount[1]);
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
