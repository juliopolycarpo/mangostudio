// Folds what the test jobs left behind into one measurement per lane.
//
// Two rules make the totals honest:
//
//   1. Completeness. A lane is `measured` only when every expected job delivered
//      a whole report AND a process receipt that is not a watchdog kill. A lost
//      report, a cut-off report, a missing receipt or a timeout makes the lane
//      `partial` (its counts are a lower bound) — never a smaller complete
//      total. A lane with nothing readable is `unavailable`, never zero.
//
//      A missing report is treated as lost even though Bun writes no file for an
//      empty `--shard` slice: every sharded lane has far more files than shards,
//      so an empty slice does not happen, and assuming it did would let a lost
//      artifact hide behind it.
//
//   2. Identity. A test seen in more than one report is one test. The later run
//      wins, and if the earlier run failed it stays visible as `recovered`. Only
//      *across* reports: inside one report two cases can legitimately share
//      file, title and line (`it.each` rows), so nothing is collapsed there.

import type { TestLane } from '../../lib/test-lanes';
import type { JunitCase, LaneOutcome } from '../junit-results';
import type { LaneResult, TestErrorHeadline } from '../model/lanes';
import { type Measurement, measured, partial, unavailable } from '../model/states';
import type { JobEvidence } from './evidence';

/** Exit code the watchdog reports for an attempt it had to kill. */
const WATCHDOG_TIMEOUT_EXIT = 124;

const MAX_HEADLINES = 5;

interface Merged {
  outcome: JunitCase['outcome'];
  file: string | null;
  headline: TestErrorHeadline | null;
  /** The failure this test had in an earlier report, when a later one did not fail. */
  recoveredFrom: TestErrorHeadline | null;
}

const asMerged = (testCase: JunitCase): Merged => ({
  outcome: testCase.outcome,
  file: testCase.file,
  headline: testCase.headline,
  recoveredFrom: null,
});

/** Later run supersedes an earlier one; an earlier failure it no longer has is kept as `recoveredFrom`. */
const supersede = (earlier: Merged, later: JunitCase): Merged => {
  const earlierFailure = earlier.outcome === 'failed' ? earlier.headline : earlier.recoveredFrom;
  return {
    ...asMerged(later),
    recoveredFrom: later.outcome === 'failed' ? null : earlierFailure,
  };
};

/**
 * Merge the cases of several reports of one lane by identity.
 * // Usage: mergeReports([reportA.cases, reportB.cases]).length
 */
const mergeReports = (reports: readonly (readonly JunitCase[])[]): readonly Merged[] => {
  const byIdentity = new Map<string, Merged[]>();
  for (const cases of reports) {
    const seenInReport = new Map<string, number>();
    for (const testCase of cases) {
      // The n-th occurrence of an identity in this report pairs with the n-th
      // occurrence in earlier reports, so repeated rows stay separate tests.
      const position = seenInReport.get(testCase.identity) ?? 0;
      seenInReport.set(testCase.identity, position + 1);
      const slots = byIdentity.get(testCase.identity) ?? [];
      const earlier = slots[position];
      slots[position] = earlier ? supersede(earlier, testCase) : asMerged(testCase);
      byIdentity.set(testCase.identity, slots);
    }
  }
  return [...byIdentity.values()].flat();
};

const uniqueHeadlines = (headlines: readonly (TestErrorHeadline | null)[]): TestErrorHeadline[] => {
  const seen = new Set<string>();
  const unique: TestErrorHeadline[] = [];
  for (const headline of headlines) {
    if (!headline || unique.length >= MAX_HEADLINES) continue;
    const key = `${headline.message}\0${headline.originatedIn ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(headline);
  }
  return unique;
};

interface JobVerdict {
  /** True only for a whole report plus a receipt that is not a timeout. */
  readonly complete: boolean;
  readonly reasons: readonly string[];
  readonly exitCode: number | null;
  /** True when the receipt says the job ran more than once. */
  readonly retried: boolean;
}

const judgeJob = (lane: TestLane, evidence: JobEvidence): JobVerdict => {
  const { id } = evidence.job;
  const reasons: string[] = [];
  const report = evidence.reports.get(lane.id) ?? { kind: 'missing' as const };
  if (report.kind === 'missing') reasons.push(`${id}: no ${lane.id} JUnit report`);
  else if (report.parsed.truncated) {
    reasons.push(`${id}: ${lane.id} JUnit report is truncated (${report.parsed.truncated})`);
  }

  const { receipt } = evidence;
  if (receipt.kind === 'missing') reasons.push(`${id}: no process receipt (${receipt.why})`);
  else if (receipt.exitCode === WATCHDOG_TIMEOUT_EXIT) {
    reasons.push(`${id}: timed out (exit ${WATCHDOG_TIMEOUT_EXIT}); its report is not trusted`);
  }
  return {
    complete: reasons.length === 0,
    reasons,
    exitCode: receipt.kind === 'read' ? receipt.exitCode : null,
    retried: receipt.kind === 'read' && (receipt.attempts ?? 1) > 1,
  };
};

const laneEvidence = (lane: TestLane, evidence: readonly JobEvidence[]): JobEvidence[] =>
  evidence.filter((entry) => entry.job.lanes.some((candidate) => candidate.id === lane.id));

/**
 * Fold one lane's evidence into a measurement.
 * `unverifiedShardSet` (from `expectedShardJobs`) forces a sharded lane out of
 * `measured`: the expected set itself was not established.
 * // Usage: foldLane(laneById('api-unit'), evidence, null)
 */
export const foldLane = (
  lane: TestLane,
  evidence: readonly JobEvidence[],
  unverifiedShardSet: string | null = null
): Measurement<LaneResult> => {
  const jobs = laneEvidence(lane, evidence);
  if (jobs.length === 0) return unavailable(`no test job is expected to carry lane ${lane.id}`);

  const verdicts = jobs.map((entry) => judgeJob(lane, entry));
  const reasons = verdicts.flatMap((verdict) => verdict.reasons);
  if (unverifiedShardSet && lane.sharded) reasons.push(unverifiedShardSet);

  const reportCases = jobs.flatMap((entry) => {
    const report = entry.reports.get(lane.id);
    return report?.kind === 'read' ? [report.parsed.cases] : [];
  });
  const merged = mergeReports(reportCases);
  const count = (outcome: JunitCase['outcome']): number =>
    merged.filter((entry) => entry.outcome === outcome).length;
  const failed = merged.filter((entry) => entry.outcome === 'failed');
  const recovered = merged.filter((entry) => entry.outcome !== 'failed' && entry.recoveredFrom);

  const result: LaneResult = {
    passed: count('passed'),
    failed: failed.length,
    skipped: count('skipped'),
    todo: count('todo'),
    recovered: recovered.length,
    failedFiles: new Set(failed.flatMap((entry) => (entry.file ? [entry.file] : []))).size,
    shards: {
      expected: jobs.length,
      complete: verdicts.filter((verdict) => verdict.complete).length,
    },
    nonZeroExits: verdicts.filter((verdict) => verdict.exitCode !== null && verdict.exitCode !== 0)
      .length,
    timedOut: verdicts.filter((verdict) => verdict.exitCode === WATCHDOG_TIMEOUT_EXIT).length,
    retriedJobs: verdicts.filter((verdict) => verdict.retried).length,
    headlines: uniqueHeadlines(failed.map((entry) => entry.headline)),
    recoveredFailures: uniqueHeadlines(recovered.map((entry) => entry.recoveredFrom)),
  };

  if (reasons.length === 0) return measured(result);
  // Nothing readable at all: a lower bound of zero would read as "no tests".
  if (merged.length === 0) return unavailable(reasons);
  return partial(result, reasons);
};

/**
 * Fold every lane of a run.
 * // Usage: foldLanes(lanes, evidence, jobSet.unverified)
 */
export const foldLanes = (
  lanes: readonly TestLane[],
  evidence: readonly JobEvidence[],
  unverifiedShardSet: string | null = null
): readonly LaneOutcome[] =>
  lanes.map((lane) => ({ lane, result: foldLane(lane, evidence, unverifiedShardSet) }));
