// Parse pass, fail, and unhandled-error counts from the teed
// `bun run test --coverage` log. Vitest and Bun summaries look similar, so
// each pattern is named for the runner that emits it.
//
// Vitest (frontend jsdom): `Test Files` / `Tests` / `Errors N error(s)`, plus
// `This error originated in "…" test file` under Unhandled Errors.
// Bun (`bun test`): `N pass` / `N fail` / `N error(s)`, plus
// `# Unhandled error between tests` blocks.
//
// Turbo `--ui=stream` prefixes are `<package>:<task>: ` (colon, not space):
// `@mangostudio/shared:test:coverage:  1 fail` and `//:test:scripts:  6 pass`.
// GitHub Actions grouped logs often omit the per-line prefix; those lines
// still parse, and Bun pass counts land on `root`.

import { ALL_WORKSPACE_NAMES, type WorkspaceName } from '../lib/config';
import type { TestErrorHeadline, TestSuiteStats } from './collect/types';

export type TestPassCounts = Readonly<Record<WorkspaceName | 'root', number>>;

const MAX_HEADLINES = 5;
const MAX_HEADLINE_CHARS = 400;

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

const WORKSPACE_NAMES = ALL_WORKSPACE_NAMES.join('|');

// Turbo stream / --log-prefix=task. Task names contain colons (`test:coverage`).
const TURBO_STREAM_RE = new RegExp(`^(?:@mangostudio/(${WORKSPACE_NAMES})|//):(\\S+):\\s+(.*)$`);

// Bun: "  6 pass" / "@mangostudio/api:test:unit:  120 pass"
const BUN_PASS_RE = /^(\d+)\s+pass$/;
const BUN_FAIL_RE = /^(\d+)\s+fail$/;
const BUN_ERROR_COUNT_RE = /^(\d+)\s+errors?$/;
const BUN_UNHANDLED_HEADING = '# Unhandled error between tests';
const BUN_ERROR_HEADLINE_RE = /^error:\s+(.+)$/;

// Vitest default reporter (padSummaryTitle + getStateString).
const VITEST_FILES_FAILED_RE = /\bTest Files\s+(\d+)\s+failed\b/;
const VITEST_TESTS_FAILED_RE = /(?:^|\s)Tests\s+(\d+)\s+failed\b/;
const VITEST_TESTS_PASSED_RE = /(?:^|\s)Tests\s+(?:\d+\s+failed\s+\|\s+)?(\d+)\s+passed\b/;
const VITEST_ERRORS_RE = /\bErrors\s+(\d+)\s+errors?\b/;
const VITEST_ORIGINATED_RE = /This error originated in "([^"]+)" test file\./;
const VITEST_HEADLINE_RE =
  /^(?:Unhandled Rejection:\s+)?((?:[A-Za-z]+)?Error|AggregateError):(?:\s+.*)?$/;
const VITEST_FAIL_LINE_RE = /^\s*FAIL\s+(\S+)/;

const WORKSPACE_NAME_SET: ReadonlySet<string> = new Set(ALL_WORKSPACE_NAMES);

const isWorkspaceName = (value: string | undefined): value is WorkspaceName =>
  value !== undefined && WORKSPACE_NAME_SET.has(value);

const emptyPassCounts = (): Record<WorkspaceName | 'root', number> =>
  Object.fromEntries(['root', ...ALL_WORKSPACE_NAMES].map((workspace) => [workspace, 0])) as Record<
    WorkspaceName | 'root',
    number
  >;

const stripAnsi = (line: string): string => line.replace(ANSI_RE, '');

const clip = (text: string): string =>
  text.length <= MAX_HEADLINE_CHARS ? text : `${text.slice(0, MAX_HEADLINE_CHARS - 1)}…`;

const headlineKey = (message: string, originatedIn: string | null): string =>
  `${message}\0${originatedIn ?? ''}`;

const pushHeadline = (
  headlines: TestErrorHeadline[],
  seen: Set<string>,
  message: string,
  originatedIn: string | null
): void => {
  if (headlines.length >= MAX_HEADLINES) return;
  const clippedMessage = clip(message.trim());
  const clippedOrigin = originatedIn ? clip(originatedIn.trim()) : null;
  // Same message with no origin yet is not a duplicate: a later originated-in
  // line may belong to a different file. Dedup once the origin is known.
  if (clippedOrigin !== null) {
    const key = headlineKey(clippedMessage, clippedOrigin);
    if (seen.has(key)) return;
    seen.add(key);
  }
  headlines.push({ message: clippedMessage, originatedIn: clippedOrigin });
};

const assignOrigin = (
  headlines: TestErrorHeadline[],
  seen: Set<string>,
  originatedIn: string
): void => {
  const last = headlines.at(-1);
  if (!last || last.originatedIn !== null) return;
  const clippedOrigin = clip(originatedIn);
  const key = headlineKey(last.message, clippedOrigin);
  if (seen.has(key)) {
    headlines.pop();
    return;
  }
  seen.add(key);
  headlines[headlines.length - 1] = { ...last, originatedIn: clippedOrigin };
};

const splitTurboStreamLine = (
  stripped: string
): {
  readonly workspace: WorkspaceName | 'root' | null;
  readonly taskKey: string;
  readonly body: string;
} => {
  const turboMatch = stripped.match(TURBO_STREAM_RE);
  if (!turboMatch) {
    return { workspace: null, taskKey: '', body: stripped.trim() };
  }
  const workspace = isWorkspaceName(turboMatch[1]) ? turboMatch[1] : 'root';
  const packageLabel = isWorkspaceName(turboMatch[1]) ? `@mangostudio/${turboMatch[1]}` : '//';
  const taskKey = `${packageLabel}:${turboMatch[2]}`;
  return { workspace, taskKey, body: (turboMatch[3] ?? '').trim() };
};

export interface ParsedTestResults {
  readonly passed: TestPassCounts;
  readonly failed: number;
  readonly failedFiles: number;
  readonly errors: number;
  readonly headlines: readonly TestErrorHeadline[];
  readonly hasFailureSignal: boolean;
}

/**
 * Parse Vitest and Bun result lines from a coverage-run log.
 * // Usage: parseTestResultCounts(await Bun.file('coverage-run.log').text())
 */
export const parseTestResultCounts = (text: string): ParsedTestResults => {
  const passed = emptyPassCounts();
  let bunFailed = 0;
  let vitestTestsFailed = 0;
  let failedFiles = 0;
  let bunErrors = 0;
  let vitestErrors = 0;
  const headlines: TestErrorHeadline[] = [];
  const seen = new Set<string>();
  const bunUnhandledOpen = new Set<string>();
  let sawBunUnhandledHeading = false;

  for (const rawLine of text.split('\n')) {
    const stripped = stripAnsi(rawLine).replace(/\r$/, '');
    if (stripped.startsWith('##[')) continue;

    const { workspace, taskKey, body } = splitTurboStreamLine(stripped);

    if (stripped.includes(BUN_UNHANDLED_HEADING) || body === BUN_UNHANDLED_HEADING) {
      bunUnhandledOpen.add(taskKey);
      sawBunUnhandledHeading = true;
      continue;
    }

    if (bunUnhandledOpen.has(taskKey)) {
      const bunHeadline = body.match(BUN_ERROR_HEADLINE_RE);
      if (bunHeadline) {
        pushHeadline(headlines, seen, `error: ${bunHeadline[1]}`, null);
        bunUnhandledOpen.delete(taskKey);
        continue;
      }
      if (body.startsWith('(pass)') || body.startsWith('(fail)') || BUN_PASS_RE.test(body)) {
        bunUnhandledOpen.delete(taskKey);
      }
    }

    const bunPass = body.match(BUN_PASS_RE);
    if (bunPass) {
      passed[workspace ?? 'root'] += Number(bunPass[1]);
      continue;
    }

    const bunFail = body.match(BUN_FAIL_RE);
    if (bunFail) {
      bunFailed += Number(bunFail[1]);
      continue;
    }

    const bunErrorCount = body.match(BUN_ERROR_COUNT_RE);
    if (bunErrorCount && !/\bErrors\s/.test(stripped)) {
      bunErrors += Number(bunErrorCount[1]);
      continue;
    }

    const originated = stripped.match(VITEST_ORIGINATED_RE);
    if (originated) {
      assignOrigin(headlines, seen, originated[1]);
      continue;
    }

    const vitestHeadline = body.match(VITEST_HEADLINE_RE);
    if (vitestHeadline) {
      pushHeadline(headlines, seen, body, null);
      continue;
    }

    const failLine = body.match(VITEST_FAIL_LINE_RE);
    if (failLine) {
      pushHeadline(headlines, seen, body.replace(/^\s*FAIL\s+/, 'FAIL '), failLine[1]);
      continue;
    }

    const filesFailed = stripped.match(VITEST_FILES_FAILED_RE);
    if (filesFailed) failedFiles += Number(filesFailed[1]);

    const testsFailed = stripped.match(VITEST_TESTS_FAILED_RE);
    if (testsFailed) vitestTestsFailed += Number(testsFailed[1]);

    // Prefixed `Tests N passed` is the workspace pass line. Bare Vitest
    // summaries (GitHub Actions grouped logs with no per-line prefix) are not
    // added here: counting them would change green-run totals against stored
    // baselines.
    const testsPassed = body.match(VITEST_TESTS_PASSED_RE);
    if (testsPassed && workspace && workspace !== 'root') {
      passed[workspace] += Number(testsPassed[1]);
    }

    const vitestErrorCount = stripped.match(VITEST_ERRORS_RE);
    if (vitestErrorCount) vitestErrors += Number(vitestErrorCount[1]);
  }

  const failed = bunFailed + vitestTestsFailed;
  const errors = bunErrors + vitestErrors;
  const hasFailureSignal =
    failed > 0 || failedFiles > 0 || errors > 0 || headlines.length > 0 || sawBunUnhandledHeading;

  return { passed, failed, failedFiles, errors, headlines, hasFailureSignal };
};

/** Pass counts only, for callers that do not need failure signals. */
export const parseTestPassCounts = (text: string): TestPassCounts =>
  parseTestResultCounts(text).passed;

/**
 * Build the tests fragment fields from a coverage-run log plus the process
 * exit code. A non-zero exit with no parsed failure signal sets `parseMiss`
 * instead of reporting zeros.
 */
export const buildTestSuiteStats = (
  logText: string,
  exitCode: number | null,
  durationSeconds: number | null
): TestSuiteStats => {
  const parsed = parseTestResultCounts(logText);
  const passedTotal = Object.values(parsed.passed).reduce((sum, count) => sum + count, 0);
  const stats: TestSuiteStats = {
    exitCode,
    durationSeconds,
    passed: passedTotal,
    ...parsed.passed,
  };

  if (parsed.hasFailureSignal) {
    return {
      ...stats,
      failed: parsed.failed,
      failedFiles: parsed.failedFiles,
      errors: parsed.errors,
      ...(parsed.headlines.length > 0 ? { headlines: parsed.headlines } : {}),
    };
  }

  if (exitCode !== 0 && exitCode !== null) {
    return { ...stats, parseMiss: true };
  }

  return stats;
};
