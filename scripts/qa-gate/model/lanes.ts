// Per-lane test results: one entry for every test lane a component owns. A lane
// is one runner invocation (`api-unit`, `api-integration`, ...), not a
// workspace, so a component with two lanes carries two entries and neither
// hides inside the other's total.
//
// Every entry is a `measurement`: a lane whose shard reports were lost or cut
// short is `partial` (its counts are a lower bound), and a lane that delivered
// nothing readable is `unavailable`. Neither can be read as zero or success.
import Type, { type Static } from 'typebox';

import { measurement } from './states';

const count = Type.Integer({ minimum: 0 });

/** One failure line: what failed and where the run was. Untrusted text, so bounded. */
export const TestErrorHeadlineSchema = Type.Object(
  {
    message: Type.String({ maxLength: 400 }),
    originatedIn: Type.Union([Type.String({ maxLength: 400 }), Type.Null()]),
  },
  { additionalProperties: false }
);

/** Lane ids come from the lane registry; the pattern leaves room for Rust lanes. */
export const LANE_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,39}$';

/**
 * Outcome counts of one lane, deduplicated by test identity: a test that
 * failed and then passed is one `passed` test plus one `recovered`, so the
 * earlier failure stays visible without being counted twice.
 */
export const LaneResultSchema = Type.Refine(
  Type.Object(
    {
      passed: count,
      failed: count,
      skipped: count,
      todo: count,
      /** Tests whose earlier run failed but whose final run did not. */
      recovered: count,
      failedFiles: count,
      /** Runner jobs expected to carry this lane, and how many delivered a complete report and receipt. */
      shards: Type.Object({ expected: count, complete: count }, { additionalProperties: false }),
      /** Jobs carrying this lane whose process exited non-zero. */
      nonZeroExits: count,
      /** Jobs carrying this lane the watchdog killed (exit 124). */
      timedOut: count,
      /** Jobs carrying this lane that ran more than once (a hang the watchdog retried). */
      retriedJobs: count,
      headlines: Type.Array(TestErrorHeadlineSchema, { maxItems: 8 }),
      recoveredFailures: Type.Array(TestErrorHeadlineSchema, { maxItems: 8 }),
    },
    { additionalProperties: false }
  ),
  (lane) => lane.shards.complete <= lane.shards.expected,
  (lane) =>
    `lane shards complete=${lane.shards.complete} expected=${lane.shards.expected} is inconsistent; expected complete <= expected`
);

export const LaneEntrySchema = Type.Object(
  {
    id: Type.String({ pattern: LANE_ID_PATTERN }),
    tests: measurement(LaneResultSchema),
  },
  { additionalProperties: false }
);

/** The lanes one component owns; an empty list means none is wired for it. */
export const ComponentLanesSchema = Type.Array(LaneEntrySchema, { maxItems: 16 });

export type TestErrorHeadline = Static<typeof TestErrorHeadlineSchema>;
export type LaneResult = Static<typeof LaneResultSchema>;
export type LaneEntry = Static<typeof LaneEntrySchema>;
