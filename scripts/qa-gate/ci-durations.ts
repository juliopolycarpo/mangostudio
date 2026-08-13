// Runtime contract for CI job timing data collected by the privileged
// workflow_run publisher. This is deliberately separate from the unprivileged
// qa-metrics envelope because reading Actions jobs requires `actions: read`.

import { describeSchemaError } from '@mangostudio/shared/errors';
import Type, { type Static } from 'typebox';
import Value from 'typebox/value';

/** Hard cap for the trusted-side JSON handoff into the report renderer. */
const CI_DURATIONS_MAX_BYTES = 1024 * 1024;

/** Job-count bound shared with the collector (pinned to report-pipeline.mjs by test). */
export const CI_JOBS_MAX_ITEMS = 500;

const nullableTimestamp = Type.Union([Type.String({ maxLength: 64 }), Type.Null()]);

const CiJobDurationSchema = Type.Object(
  {
    name: Type.String({ maxLength: 500 }),
    status: Type.String({ maxLength: 40 }),
    conclusion: Type.Union([Type.String({ maxLength: 40 }), Type.Null()]),
    startedAt: nullableTimestamp,
    completedAt: nullableTimestamp,
  },
  { additionalProperties: false }
);

const CiRunDurationsSchema = Type.Object(
  {
    runId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    error: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
    jobs: Type.Array(CiJobDurationSchema, { maxItems: CI_JOBS_MAX_ITEMS }),
  },
  { additionalProperties: false }
);

const CiDurationComparisonSchema = Type.Object(
  {
    base: CiRunDurationsSchema,
    head: CiRunDurationsSchema,
    previous: CiRunDurationsSchema,
  },
  { additionalProperties: false }
);

export type CiJobDuration = Static<typeof CiJobDurationSchema>;
export type CiRunDurations = Static<typeof CiRunDurationsSchema>;
export type CiDurationComparison = Static<typeof CiDurationComparisonSchema>;

const firstSchemaError = (value: unknown): string => {
  return describeSchemaError(
    Value.Errors(CiDurationComparisonSchema, value),
    'unknown schema violation'
  );
};

/** Parse the Actions API timing handoff before it reaches Markdown rendering. */
export const parseCiDurationComparison = (text: string): CiDurationComparison => {
  if (Buffer.byteLength(text, 'utf8') > CI_DURATIONS_MAX_BYTES) {
    throw new Error(`CI duration payload exceeds ${CI_DURATIONS_MAX_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('CI duration payload is not valid JSON');
  }

  if (!Value.Check(CiDurationComparisonSchema, parsed)) {
    throw new Error(`CI duration payload failed schema validation (${firstSchemaError(parsed)})`);
  }

  return parsed;
};
