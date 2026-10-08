// Count test outcomes from the JUnit XML each lane writes, and turn the folded
// per-lane results (./results/) into the suite-level tally the fragment carries.
//
// This replaces parsing the runner log. The XML itself is read by
// ../lib/junit-report.ts (counts come from `<testcase>` elements, not the header).
//
// What JUnit cannot carry is unhandled errors: Bun's `# Unhandled error
// between tests` block leaves the report at `failures="0"` with no failing
// case while the run exits 1. Those counts and headlines come from
// ./unhandled-errors.ts instead.

import { ALL_WORKSPACE_NAMES, type WorkspaceName } from '../lib/config';
import { MAX_HEADLINES } from '../lib/junit-report';
import type { TestLane } from '../lib/test-lanes';
import type { LaneResult, TestSuiteStats } from './collect/types';
import { type Measurement, presentValue } from './model/states';
import type { UnhandledErrors } from './unhandled-errors';

// The parser lives in scripts/lib/junit-report.ts so the worker lanes can use it
// without loading the QA gate. Re-exported: this is where its callers import it.
export { type JunitCase, type JunitCounts, parseJunitXml } from '../lib/junit-report';

/** One lane's fold: its registry entry and the measurement of its results. */
export interface LaneOutcome {
  readonly lane: TestLane;
  readonly result: Measurement<LaneResult>;
}

const NO_RESULT: LaneResult = {
  passed: 0,
  failed: 0,
  skipped: 0,
  todo: 0,
  recovered: 0,
  failedFiles: 0,
  shards: { expected: 0, complete: 0 },
  nonZeroExits: 0,
  timedOut: 0,
  retriedJobs: 0,
  headlines: [],
  recoveredFailures: [],
};

/** Sum one counter over every lane that has a value; an unavailable lane adds nothing. */
const sumPresent = (outcomes: readonly LaneOutcome[], pick: (lane: LaneResult) => number): number =>
  outcomes.reduce((sum, { result }) => sum + pick(presentValue(result) ?? NO_RESULT), 0);

/** Fold lane results into the per-workspace pass counts the QA fragment carries. */
const passCountsByWorkspace = (
  outcomes: readonly LaneOutcome[]
): Readonly<Record<WorkspaceName | 'root', number>> => {
  // Derived, never hand-listed: a workspace missing from this seed would make
  // `counts[lane.workspace] += n` produce NaN and serialize the total as null.
  const counts: Record<string, number> = Object.fromEntries(
    ['root', ...ALL_WORKSPACE_NAMES].map((workspace) => [workspace, 0])
  );
  for (const { lane, result } of outcomes) {
    counts[lane.workspace] += presentValue(result)?.passed ?? 0;
  }
  return counts as Readonly<Record<WorkspaceName | 'root', number>>;
};

/**
 * Build the QA fragment's tests entry from the folded lanes plus the unhandled
 * errors JUnit cannot carry. The counters are lower bounds whenever a lane is
 * not `measured`; the caller states that with a `partial` measurement.
 *
 * Failure fields stay omitted on a green run so stored baselines and the
 * rendered report are unchanged by this switch. `parseMiss` keeps its meaning:
 * nothing structured explains the outcome — a non-zero exit with no JUnit
 * failures, or a configured lane that delivered no results at all (Bun can
 * fail to write JUnit and still exit 0).
 * // Usage: buildTestSuiteStats(outcomes, errors, 0, 91);
 */
export const buildTestSuiteStats = (
  outcomes: readonly LaneOutcome[],
  unhandledErrors: UnhandledErrors,
  exitCode: number | null,
  durationSeconds: number | null
): TestSuiteStats => {
  const passedByWorkspace = passCountsByWorkspace(outcomes);
  const failed = sumPresent(outcomes, (lane) => lane.failed);
  // Bun's `file` attribute is workspace-relative, so the same path in two
  // lanes is two files; each lane already counts its own distinct files.
  const failedFiles = sumPresent(outcomes, (lane) => lane.failedFiles);
  const headlines = [
    ...outcomes.flatMap(({ result }) => presentValue(result)?.headlines ?? []),
    ...unhandledErrors.headlines,
  ].slice(0, MAX_HEADLINES);

  const stats: TestSuiteStats = {
    exitCode,
    durationSeconds,
    passed: Object.values(passedByWorkspace).reduce((sum, count) => sum + count, 0),
    ...passedByWorkspace,
  };

  const hasFailureSignal =
    failed > 0 || failedFiles > 0 || unhandledErrors.errors > 0 || headlines.length > 0;
  // A lane with no readable result is not an empty shard slice: every
  // configured lane is expected to deliver at least one report across the
  // shard set. Bun can print `JUnitReportFailed` and still exit 0, which would
  // otherwise tally as a green suite of zero tests.
  const unreadableLane = outcomes.some(({ result }) => presentValue(result) === null);

  if (hasFailureSignal) {
    return {
      ...stats,
      failed,
      failedFiles,
      errors: unhandledErrors.errors,
      ...(headlines.length > 0 ? { headlines } : {}),
      ...(unreadableLane ? { parseMiss: true } : {}),
    };
  }

  if (unreadableLane || (exitCode !== 0 && exitCode !== null)) {
    return { ...stats, parseMiss: true };
  }

  return stats;
};
