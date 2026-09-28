// Loads one untrusted qa-metrics artifact for the report renderer and turns
// every way it can be unusable into a note. An envelope recorded under another
// schema version (v3 and older) is reported as `incomparable`: it is not read,
// and no delta is computed against it.

import type { Metrics } from './collect/types';
import {
  type EnvelopeParseOptions,
  type ExpectedEnvelope,
  IncomparableEnvelopeError,
  parseQaMetricsEnvelope,
} from './metrics-envelope';

/** What the publisher found when it looked for the artifact. */
export interface ArtifactStatus {
  readonly found: boolean;
  readonly reason: string | null;
}

export interface LoadedMetrics {
  readonly metrics: Metrics | null;
  /** Why the metrics are unavailable; null when they loaded. */
  readonly note: string | null;
  /** True when the artifact exists but was recorded under another schema version. */
  readonly incomparable: boolean;
}

const unavailable = (note: string, incomparable = false): LoadedMetrics => ({
  metrics: null,
  note,
  incomparable,
});

/**
 * Validate the artifact at `path` against the trusted expectations.
 * // Usage: await loadMetrics(basePath, context.baseArtifact, expected, 'base', {}, log)
 */
export const loadMetrics = async (
  path: string | null,
  artifact: ArtifactStatus,
  expected: ExpectedEnvelope,
  side: 'head' | 'base',
  options: EnvelopeParseOptions = {},
  log: (message: string) => void = () => undefined
): Promise<LoadedMetrics> => {
  if (!artifact.found) return unavailable(artifact.reason ?? 'artifact not found');
  if (!path || !(await Bun.file(path).exists())) {
    return unavailable('artifact payload could not be extracted');
  }
  try {
    const envelope = parseQaMetricsEnvelope(await Bun.file(path).text(), expected, options);
    return { metrics: envelope.metrics, note: null, incomparable: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`${side} metrics rejected: ${message}`);
    return unavailable(message, err instanceof IncomparableEnvelopeError);
  }
};
