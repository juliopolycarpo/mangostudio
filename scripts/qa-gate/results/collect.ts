// Adapters from what the existing test run left on disk to the fragment's
// per-lane results. Nothing here runs a test: it only reads the JUnit reports
// and process receipts the run already wrote.

import type { TestLane } from '../../lib/test-lanes';
import type { LaneOutcome } from '../junit-results';
import type { LaneResult } from '../model/lanes';
import type { TestSuiteStats } from '../model/metrics';
import { type Measurement, measured, partial } from '../model/states';
import { type ReadText, type ReceiptEvidence, readJobEvidence } from './evidence';
import type { ExpectedJobSet } from './expected-jobs';
import { foldLanes } from './fold';

export interface CollectLanesOptions {
  readonly jobSet: ExpectedJobSet;
  readonly lanes: readonly TestLane[];
  readonly readText: ReadText;
  /** Receipt to use instead of a per-job file (a single-machine run). */
  readonly receiptOverride?: ReceiptEvidence;
}

/**
 * Read every expected job and fold each lane.
 * // Usage: await collectLaneOutcomes({ jobSet: expectedShardJobs('shards', 8), lanes: TEST_LANES, readText: readTextOrNull })
 */
export const collectLaneOutcomes = async (
  options: CollectLanesOptions
): Promise<readonly LaneOutcome[]> => {
  const evidence = await Promise.all(
    options.jobSet.jobs.map((job) =>
      readJobEvidence(job, options.readText, options.receiptOverride)
    )
  );
  return foldLanes(options.lanes, evidence, options.jobSet.unverified);
};

/** Lane measurements keyed by lane id, the shape the fragment carries. */
export const laneCells = (
  outcomes: readonly LaneOutcome[]
): Record<string, Measurement<LaneResult>> =>
  Object.fromEntries(outcomes.map(({ lane, result }) => [lane.id, result]));

/**
 * The suite-level measurement: `measured` only when every lane is. Otherwise the
 * counters are a lower bound, so the value is kept but flagged `partial` with
 * one reason per lane that fell short.
 * // Usage: suiteMeasurement(buildTestSuiteStats(outcomes, errors, 0, 91), outcomes)
 */
export const suiteMeasurement = (
  stats: TestSuiteStats,
  outcomes: readonly LaneOutcome[]
): Measurement<TestSuiteStats> => {
  const reasons = outcomes.flatMap(({ lane, result }) =>
    result.state === 'measured' ? [] : [`${lane.id} ${result.state}: ${result.reasons[0]}`]
  );
  return reasons.length === 0 ? measured(stats) : partial(stats, reasons);
};
