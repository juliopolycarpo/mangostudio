// The v4 `qa-metrics` envelope: identity fields the publisher checks against
// trusted GitHub data, producer provenance, and the `Metrics` document.

import Type, { type Static } from 'typebox';

import { MetricsSchema } from './metrics';

/** Bump when the envelope or Metrics shape changes incompatibly. v3 data is incomparable. */
export const QA_METRICS_SCHEMA_VERSION = 4;

/** Full commit SHA pattern shared by every identity and provenance field. */
export const SHA_PATTERN = '^[0-9a-f]{40}$';

/**
 * Who produced the envelope and from what: the commit that was actually
 * measured (`sourceSha`, the merge commit on pull_request runs, so it is not
 * `headSha`), the producing tool, and the workflow run and attempt.
 */
const ProvenanceSchema = Type.Object(
  {
    sourceSha: Type.String({ pattern: SHA_PATTERN }),
    producer: Type.Object(
      {
        name: Type.String({ pattern: '^[A-Za-z0-9_.@/-]{1,80}$' }),
        version: Type.String({ pattern: '^[A-Za-z0-9_.+-]{1,64}$' }),
      },
      { additionalProperties: false }
    ),
    runId: Type.Integer({ minimum: 1 }),
    runAttempt: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);

export const QaMetricsEnvelopeSchema = Type.Refine(
  Type.Object(
    {
      schemaVersion: Type.Literal(QA_METRICS_SCHEMA_VERSION),
      repository: Type.String({ pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', maxLength: 140 }),
      prNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      baseSha: Type.Union([Type.String({ pattern: SHA_PATTERN }), Type.Null()]),
      headSha: Type.String({ pattern: SHA_PATTERN }),
      provenance: ProvenanceSchema,
      metrics: MetricsSchema,
    },
    { additionalProperties: false }
  ),
  (envelope) => envelope.metrics.sha === envelope.provenance.sourceSha,
  (envelope) =>
    `metrics sha ${envelope.metrics.sha} differs from provenance sourceSha ${envelope.provenance.sourceSha}; expected the same measured commit`
);

export type Provenance = Static<typeof ProvenanceSchema>;
export type QaMetricsEnvelope = Static<typeof QaMetricsEnvelopeSchema>;
