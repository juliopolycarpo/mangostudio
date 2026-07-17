// Versioned envelope for the `qa-metrics` CI artifact. The unprivileged
// collector (collect.ts) wraps its Metrics document with provenance fields;
// the trusted publisher validates untrusted artifact JSON against this schema
// (owned by the default branch) before rendering anything from it.

import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import type { Metrics } from './collect/types';

/** Bump when the envelope or Metrics shape changes incompatibly. */
export const QA_METRICS_SCHEMA_VERSION = 1;
/** Artifact name used for both PR-head and main-baseline uploads. */
export const QA_METRICS_ARTIFACT_NAME = 'qa-metrics';
/** File name inside the artifact archive. */
export const QA_METRICS_FILE_NAME = 'metrics.json';
/** Hard cap on the artifact payload; anything larger is rejected unread. */
export const QA_METRICS_MAX_BYTES = 1024 * 1024;

const shaPattern = '^[0-9a-f]{40}$';
const boundedError = Type.Object(
  { error: Type.String({ maxLength: 2000 }) },
  { additionalProperties: false }
);
const failable = <T extends TSchema>(schema: T) => Type.Union([schema, boundedError]);

const coverageBucket = Type.Object(
  {
    total: Type.Number(),
    covered: Type.Number(),
    pct: Type.Union([Type.Number(), Type.Null()]),
  },
  { additionalProperties: false }
);

const coverageSummary = Type.Object(
  {
    lines: coverageBucket,
    functions: coverageBucket,
    statements: Type.Union([coverageBucket, Type.Null()]),
    branches: Type.Union([coverageBucket, Type.Null()]),
  },
  { additionalProperties: false }
);

const locBucket = Type.Object(
  {
    files: Type.Number(),
    code: Type.Number(),
    comment: Type.Number(),
    blank: Type.Number(),
    total: Type.Number(),
  },
  { additionalProperties: false }
);

const metricsSchema = Type.Object(
  {
    sha: Type.String({ pattern: '^([0-9a-f]{40}|unknown)$' }),
    generatedAt: Type.String({ maxLength: 64 }),
    loc: Type.Object(
      {
        frontend: failable(locBucket),
        api: failable(locBucket),
        shared: failable(locBucket),
        total: failable(locBucket),
      },
      { additionalProperties: false }
    ),
    coverage: Type.Object(
      {
        frontend: failable(coverageSummary),
        api: failable(coverageSummary),
        shared: failable(coverageSummary),
      },
      { additionalProperties: false }
    ),
    tsErrors: Type.Object(
      {
        frontend: failable(Type.Number()),
        api: failable(Type.Number()),
        shared: failable(Type.Number()),
      },
      { additionalProperties: false }
    ),
    duplication: failable(
      Type.Object(
        {
          clones: Type.Number(),
          duplicatedLines: Type.Number(),
          percentage: Type.Number(),
        },
        { additionalProperties: false }
      )
    ),
    circularDeps: failable(Type.Number()),
    frontendBundle: failable(
      Type.Object(
        {
          files: Type.Number(),
          rawBytes: Type.Number(),
          gzipBytes: Type.Number(),
          jsGzipBytes: Type.Number(),
          cssGzipBytes: Type.Number(),
          htmlGzipBytes: Type.Number(),
        },
        { additionalProperties: false }
      )
    ),
    dependencies: failable(
      Type.Object(
        {
          workspaceManifests: Type.Number(),
          directDependencies: Type.Number(),
          directDevDependencies: Type.Number(),
          lockedPackages: Type.Number(),
        },
        { additionalProperties: false }
      )
    ),
    tests: failable(
      Type.Object(
        {
          exitCode: Type.Union([Type.Number(), Type.Null()]),
          durationSeconds: Type.Union([Type.Number(), Type.Null()]),
          passed: Type.Number(),
          root: Type.Number(),
          frontend: Type.Number(),
          api: Type.Number(),
          shared: Type.Number(),
        },
        { additionalProperties: false }
      )
    ),
    tooling: failable(
      Type.Object(
        {
          checkExitCode: Type.Number(),
          failedTasks: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 64 }),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

const QaMetricsEnvelopeSchema = Type.Object(
  {
    schemaVersion: Type.Integer({ minimum: 1 }),
    repository: Type.String({ pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$', maxLength: 140 }),
    prNumber: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    baseSha: Type.Union([Type.String({ pattern: shaPattern }), Type.Null()]),
    headSha: Type.String({ pattern: shaPattern }),
    metrics: metricsSchema,
  },
  { additionalProperties: false }
);

export interface QaMetricsEnvelope {
  readonly schemaVersion: number;
  readonly repository: string;
  readonly prNumber: number | null;
  readonly baseSha: string | null;
  readonly headSha: string;
  readonly metrics: Metrics;
}

// Compile-time guard that the schema stays in sync with collect/types.ts: a
// document accepted by the schema must be a valid Metrics for the renderer.
const _METRICS_SCHEMA_MATCHES_TYPES: Static<
  typeof QaMetricsEnvelopeSchema
>['metrics'] extends Metrics
  ? true
  : never = true;

/** Provenance the artifact must prove before its metrics are trusted. */
export interface ExpectedEnvelope {
  readonly repository: string;
  readonly headSha: string;
  readonly baseSha: string | null;
  readonly prNumber: number | null;
}

export interface EnvelopeParseOptions {
  /** Head envelopes record the mutable PR base tip; identity is repo+headSha+prNumber. */
  readonly enforceBaseSha?: boolean;
}

const firstSchemaError = (value: unknown): string => {
  const first = Value.Errors(QaMetricsEnvelopeSchema, value).First();
  return first ? `${first.path || '/'}: ${first.message}` : 'unknown schema violation';
};

/**
 * Parse and validate an untrusted qa-metrics artifact payload.
 *
 * Enforces the size cap, the TypeBox schema, the collector version, and an
 * exact match of provenance fields against `expected` (values the publisher
 * derived from trusted GitHub API data, never from the artifact). Head
 * envelopes may skip the mutable `baseSha` comparison because repository,
 * headSha, and prNumber establish their identity. Throws with a reason on any
 * enforced mismatch.
 *
 * // Usage: parseQaMetricsEnvelope(text, { repository, headSha, baseSha, prNumber })
 */
export const parseQaMetricsEnvelope = (
  text: string,
  expected: ExpectedEnvelope,
  options: EnvelopeParseOptions = {}
): QaMetricsEnvelope => {
  if (Buffer.byteLength(text, 'utf8') > QA_METRICS_MAX_BYTES) {
    throw new Error(`metrics payload exceeds ${QA_METRICS_MAX_BYTES} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('metrics payload is not valid JSON');
  }

  if (!Value.Check(QaMetricsEnvelopeSchema, parsed)) {
    throw new Error(`metrics payload failed schema validation (${firstSchemaError(parsed)})`);
  }

  if (parsed.schemaVersion !== QA_METRICS_SCHEMA_VERSION) {
    throw new Error(
      `metrics schema version ${parsed.schemaVersion} does not match expected ${QA_METRICS_SCHEMA_VERSION}`
    );
  }
  if (parsed.repository !== expected.repository) {
    throw new Error(
      `metrics repository ${parsed.repository} does not match ${expected.repository}`
    );
  }
  if (parsed.headSha !== expected.headSha) {
    throw new Error(`metrics headSha ${parsed.headSha} does not match ${expected.headSha}`);
  }
  if ((options.enforceBaseSha ?? true) && parsed.baseSha !== expected.baseSha) {
    throw new Error(`metrics baseSha ${parsed.baseSha} does not match ${expected.baseSha}`);
  }
  if (parsed.prNumber !== expected.prNumber) {
    throw new Error(`metrics prNumber ${parsed.prNumber} does not match ${expected.prNumber}`);
  }

  return parsed as QaMetricsEnvelope;
};
