import {
  type ApprovedArtifact,
  type ArtifactEvidence,
  validateArtifactEvidence,
} from './distribution-artifact';
import { parseGitHubTimestamp } from './github-timestamp';
import { isValidSemver } from './release-version';

/** Immutable CI distribution approved for both independent publication channels. */
export interface CanaryDistribution {
  readonly checksums: ApprovedArtifact;
  readonly assets: ApprovedArtifact;
  readonly npm: ApprovedArtifact;
  readonly builtAt: string;
}

/** Main push boundary carried inside the builder-attested checksums bundle. */
export interface CanaryPushContext {
  readonly repository: string;
  readonly before: string;
  readonly after: string;
  readonly event: 'push';
  readonly ref: 'refs/heads/main';
}

/** Validate a push boundary after authenticating its enclosing CI bundle. Example: parseCanaryPushContext(json, repository, sourceSha). */
export function parseCanaryPushContext(
  raw: string,
  repository: string,
  sourceSha: string
): CanaryPushContext {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid CI push context: ${raw}; expected main push object`);
  const context = value as Record<string, unknown>;
  if (
    context.repository !== repository ||
    context.after !== sourceSha ||
    context.event !== 'push' ||
    context.ref !== 'refs/heads/main' ||
    typeof context.before !== 'string' ||
    !/^[0-9a-f]{40}$/.test(context.before) ||
    !/^[0-9a-f]{40}$/.test(sourceSha)
  ) {
    throw new Error(
      `Invalid CI push context: ${raw}; expected ${repository} main push ending at ${sourceSha} with full before SHA`
    );
  }
  return {
    repository,
    before: context.before,
    after: sourceSha,
    event: 'push',
    ref: 'refs/heads/main',
  };
}

/** Resolve exactly one retained bundle per publication scope from one successful builder attempt. Example: resolveCanaryDistribution(approval, version, evidence). */
export function resolveCanaryDistribution(
  source: Omit<ApprovedArtifact, 'artifactId' | 'artifactName' | 'digest'>,
  version: string,
  evidence: {
    readonly run: ArtifactEvidence['run'];
    readonly jobs: ArtifactEvidence['jobs'];
    readonly artifacts: readonly ArtifactEvidence['artifact'][];
  }
): CanaryDistribution {
  if (!isValidSemver(version) || !version.includes('-canary.'))
    throw new Error(`Invalid promotion version: ${version}; expected canary semver`);
  const producers = evidence.jobs.filter(
    (job) =>
      job.name === 'Distribution / Build immutable distribution' &&
      job.run_id === source.runId &&
      job.run_attempt === source.producerAttempt &&
      job.conclusion === 'success'
  );
  const producer = producers[0];
  if (producers.length !== 1 || !producer)
    throw new Error(
      `Invalid distribution producer: expected one completed successful builder in attempt ${source.producerAttempt}`
    );
  const started = parseGitHubTimestamp(producer.started_at, 'Distribution producer started_at');
  const completed = parseGitHubTimestamp(
    producer.completed_at,
    'Distribution producer completed_at'
  );
  if (completed < started)
    throw new Error(
      `Distribution producer: expected ordered timestamps; received ${JSON.stringify(producer)}`
    );
  const resolve = (scope: string): ApprovedArtifact => {
    const prefix = `distribution-${scope}-${source.sourceSha.slice(0, 12)}-${version}-`;
    const matches = evidence.artifacts.filter((artifact) => {
      if (
        !artifact.name?.startsWith(prefix) ||
        !/^[a-f0-9]{12}$/.test(artifact.name.slice(prefix.length))
      )
        return false;
      const created = parseGitHubTimestamp(artifact.created_at, 'Distribution artifact created_at');
      return started <= created && created <= completed;
    });
    const artifact = matches[0];
    if (matches.length !== 1 || !artifact)
      throw new Error(
        `Distribution ${scope}: expected exactly one retained artifact from builder attempt ${source.producerAttempt}, received ${matches.length}; recover the original approved artifacts or publish the next source version, never rebuild a partial version`
      );
    const approval = {
      ...source,
      artifactId: artifact.id,
      artifactName: artifact.name,
      digest: artifact.digest,
    };
    validateArtifactEvidence(approval, { run: evidence.run, artifact, jobs: evidence.jobs });
    return approval;
  };
  return {
    checksums: resolve('checksums'),
    assets: resolve('assets'),
    npm: resolve('npm'),
    builtAt: producer.completed_at,
  };
}
