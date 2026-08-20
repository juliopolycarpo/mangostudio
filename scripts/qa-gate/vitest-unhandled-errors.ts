// Extract Vitest's unhandled-error headlines from a run log.
//
// This is the one test signal JUnit cannot carry. Vitest's JUnit reporter is
// `onTestRunEnd(testModules)` — it never receives the run's `unhandledErrors`
// and writes `errors="0"` unconditionally — and its JSON reporter takes the
// same argument. So the failure mode `docs/reference/testing.md` documents
// under "Unhandled Errors With Green Test Counts" (every file green, an
// `Errors N errors` line, exit 1) is invisible in structured output and has to
// come from the log.
//
// Everything else the old log parser did — pass, fail and skip counts for both
// runners, Turbo's stream prefixes, Bun's unhandled-error blocks — now comes
// from ./junit-results.ts.
//
// Usage: bun ./scripts/qa-gate/vitest-unhandled-errors.ts <run.log> > errors.json

import type { TestErrorHeadline } from './collect/types';

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

// Turbo `--ui=stream` prefixes lines with `<package>:<task>: `. Shard jobs run
// the lanes through Turbo, so the prefix is present there and absent in the
// merge job's direct Vitest invocation; tolerate both.
const TURBO_PREFIX_RE = /^(?:@[\w/-]+|\/\/):[\w:-]+:\s+/;

// Vitest default reporter (padSummaryTitle + getStateString).
const VITEST_ERRORS_RE = /\bErrors\s+(\d+)\s+errors?\b/;
const VITEST_ORIGINATED_RE = /This error originated in "([^"]+)" test file\./;
const VITEST_HEADLINE_RE =
  /^(?:Unhandled Rejection:\s+)?((?:[A-Za-z]+)?Error|AggregateError):(?:\s+.*)?$/;

const MAX_HEADLINES = 5;
const MAX_HEADLINE_CHARS = 400;

export interface VitestUnhandledErrors {
  /** The `Errors N errors` total Vitest prints; 0 when the line never appeared. */
  readonly errors: number;
  readonly headlines: readonly TestErrorHeadline[];
}

const clip = (text: string): string =>
  text.length <= MAX_HEADLINE_CHARS ? text : `${text.slice(0, MAX_HEADLINE_CHARS - 1)}…`;

/**
 * Parse a run log for Vitest's unhandled-error count and headlines.
 * // Usage: parseVitestUnhandledErrors(await Bun.file('run.log').text());
 */
export const parseVitestUnhandledErrors = (text: string): VitestUnhandledErrors => {
  let errors = 0;
  const headlines: TestErrorHeadline[] = [];
  const seen = new Set<string>();

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
    const body = stripped.replace(TURBO_PREFIX_RE, '').trim();

    const originated = stripped.match(VITEST_ORIGINATED_RE);
    if (originated) {
      assignOrigin(originated[1]);
      continue;
    }

    if (VITEST_HEADLINE_RE.test(body)) {
      push(body);
      continue;
    }

    const errorCount = stripped.match(VITEST_ERRORS_RE);
    if (errorCount) errors += Number(errorCount[1]);
  }

  return { errors, headlines };
};

/** Union several logs' findings, keeping at most `MAX_HEADLINES` headlines. */
export const mergeVitestUnhandledErrors = (
  parts: readonly VitestUnhandledErrors[]
): VitestUnhandledErrors => ({
  errors: parts.reduce((sum, part) => sum + part.errors, 0),
  headlines: parts.flatMap((part) => part.headlines).slice(0, MAX_HEADLINES),
});

if (import.meta.main) {
  const [, , logPath] = process.argv;
  if (!logPath) {
    process.stderr.write(
      'Usage: bun ./scripts/qa-gate/vitest-unhandled-errors.ts <run.log> > errors.json\n'
    );
    process.exit(1);
  }
  const file = Bun.file(logPath);
  const parsed = (await file.exists())
    ? parseVitestUnhandledErrors(await file.text())
    : { errors: 0, headlines: [] };
  process.stdout.write(`${JSON.stringify(parsed)}\n`);
}
