// Versioned envelope for the `qa-metrics` CI artifact. The unprivileged
// collector (collect.ts) wraps its Metrics document with provenance fields;
// the trusted publisher validates untrusted artifact JSON against this schema
// (owned by the default branch) before rendering anything from it.

import { describeSchemaError } from '@mangostudio/shared/errors';
import Value from 'typebox/value';

import {
  QA_METRICS_SCHEMA_VERSION,
  type QaMetricsEnvelope,
  QaMetricsEnvelopeSchema,
} from './model/envelope';

export { QA_METRICS_SCHEMA_VERSION, type QaMetricsEnvelope };
/** Artifact name used for both PR-head and main-baseline uploads. */
export const QA_METRICS_ARTIFACT_NAME = 'qa-metrics';
/** File name inside the artifact archive. */
export const QA_METRICS_FILE_NAME = 'metrics.json';
/** Hard cap on the artifact payload; anything larger is rejected unread. */
export const QA_METRICS_MAX_BYTES = 1024 * 1024;

/**
 * An envelope recorded under another schema version. Older data (v3 and
 * before) is historical: it is never read, and comparing it with v4 metrics
 * would report deltas between numbers that do not mean the same thing.
 */
export class IncomparableEnvelopeError extends Error {
  constructor(readonly foundVersion: number) {
    super(
      `metrics schema version ${foundVersion} is incomparable with expected ${QA_METRICS_SCHEMA_VERSION}; older envelopes are historical and are not read`
    );
    this.name = 'IncomparableEnvelopeError';
  }
}

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
  return describeSchemaError(
    Value.Errors(QaMetricsEnvelopeSchema, value),
    'unknown schema violation'
  );
};

/**
 * Parse and validate an untrusted qa-metrics artifact payload.
 *
 * Enforces the size cap, the schema version (an envelope of another version
 * throws IncomparableEnvelopeError before any shape check), the TypeBox schema,
 * and an
 * exact match of provenance fields against `expected` (values the publisher
 * derived from trusted GitHub API data, never from the artifact). Head
 * envelopes may skip the mutable `baseSha` comparison because repository,
 * headSha, and prNumber establish their identity. Throws with a reason on any
 * enforced mismatch.
 *
 * // Usage: parseQaMetricsEnvelope(text, { repository, headSha, baseSha, prNumber }, { enforceBaseSha })
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

  const foundVersion = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (Number.isInteger(foundVersion) && foundVersion !== QA_METRICS_SCHEMA_VERSION) {
    throw new IncomparableEnvelopeError(foundVersion as number);
  }

  if (!Value.Check(QaMetricsEnvelopeSchema, parsed)) {
    throw new Error(`metrics payload failed schema validation (${firstSchemaError(parsed)})`);
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

  return parsed;
};

/**
 * Serialize an envelope the collector built, refusing to emit one the
 * publisher would reject. Fails in the collecting job (with the location and
 * reason) instead of as a missing report later.
 *
 * // Usage: process.stdout.write(serializeQaMetricsEnvelope(envelope))
 */
export const serializeQaMetricsEnvelope = (envelope: QaMetricsEnvelope): string => {
  if (!Value.Check(QaMetricsEnvelopeSchema, envelope)) {
    throw new Error(
      `refusing to emit an invalid qa-metrics envelope (${firstSchemaError(envelope)})`
    );
  }
  const text = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(text, 'utf8') > QA_METRICS_MAX_BYTES) {
    throw new Error(
      `qa-metrics envelope is ${Buffer.byteLength(text, 'utf8')} bytes; expected at most ${QA_METRICS_MAX_BYTES}`
    );
  }
  return text;
};
