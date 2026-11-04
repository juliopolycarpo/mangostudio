import { type CanaryDistribution, resolveCanaryDistribution } from './canary-promotion';
import { type ApprovedArtifact, type ArtifactEvidence } from './distribution-artifact';

/** Frozen CI identity selected before resolving any distribution metadata. */
export type CanaryPromotionSelection = Pick<
  ApprovedArtifact,
  'repository' | 'runId' | 'runAttempt' | 'sourceSha'
>;

/** Project-owned metadata boundary; list must reject failed or incomplete pagination. */
export interface CanaryPromotionApi {
  get(path: string): unknown;
  list(path: string, key: string): readonly unknown[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: expected object; received ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label}: expected positive safe integer; received ${JSON.stringify(value)}`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    const parsed = Date.parse(value);
    const canonical = value.length === 20 ? `${value.slice(0, -1)}.000Z` : value;
    if (Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical) return parsed;
  }
  throw new Error(
    `Distribution producer ${label}: expected UTC ISO timestamp; received ${JSON.stringify(value)}`
  );
}

/**
 * Resolve the retained publication scopes from the frozen CI attempt without building.
 * Example: resolveCanaryPromotionSource({ repository: 'owner/repo', runId: 1, runAttempt: 2, sourceSha }, version, api).
 */
export function resolveCanaryPromotionSource(
  source: CanaryPromotionSelection,
  version: string,
  api: CanaryPromotionApi
): CanaryDistribution {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository)) {
    throw new Error(`Promotion repository: expected owner/repo; received ${source.repository}`);
  }
  if (!/^[a-f0-9]{40}$/.test(source.sourceSha)) {
    throw new Error(
      `Promotion source SHA: expected full lowercase SHA; received ${source.sourceSha}`
    );
  }
  integer(source.runId, 'Promotion run ID');
  integer(source.runAttempt, 'Promotion run attempt');
  const base = `repos/${source.repository}/actions`;
  const workflow = object(api.get(`${base}/workflows/ci.yml`), 'CI workflow');
  const workflowId = integer(workflow.id, 'CI workflow ID');
  if (workflow.path !== '.github/workflows/ci.yml' || workflow.state !== 'active') {
    throw new Error(
      `CI workflow: expected active .github/workflows/ci.yml; received ${JSON.stringify(workflow)}`
    );
  }
  const rawRun = object(
    api.get(`${base}/runs/${source.runId}/attempts/${source.runAttempt}`),
    'Frozen CI attempt'
  );
  const repository = object(rawRun.repository, 'CI repository');
  const headRepository = object(rawRun.head_repository, 'CI head repository');
  const repositoryId = integer(repository.id, 'CI repository ID');
  integer(headRepository.id, 'CI head repository ID');
  integer(rawRun.run_number, 'CI run number');
  const expectedUrl = `https://github.com/${source.repository}/actions/runs/${source.runId}`;
  if (
    rawRun.id !== source.runId ||
    rawRun.run_attempt !== source.runAttempt ||
    rawRun.workflow_id !== workflowId ||
    rawRun.path !== '.github/workflows/ci.yml' ||
    rawRun.event !== 'push' ||
    rawRun.head_branch !== 'main' ||
    rawRun.head_sha !== source.sourceSha ||
    rawRun.status !== 'completed' ||
    rawRun.conclusion !== 'success' ||
    rawRun.html_url !== expectedUrl ||
    repository.full_name !== source.repository ||
    headRepository.full_name !== source.repository ||
    headRepository.id !== repositoryId
  ) {
    throw new Error(
      `Frozen CI attempt: expected successful ${source.repository} ci.yml main push ${source.sourceSha}, run ${source.runId} attempt ${source.runAttempt} at ${expectedUrl}; received ${JSON.stringify(rawRun)}`
    );
  }
  const jobs = api.list(`${base}/runs/${source.runId}/jobs?filter=all&per_page=100`, 'jobs');
  const producers = jobs
    .map((job) => object(job, 'CI job'))
    .filter((job) => job.name === 'Distribution / Build immutable distribution');
  for (const producer of producers) {
    integer(producer.run_attempt, 'Distribution producer attempt');
    integer(producer.id, 'Distribution producer ID');
    if (producer.run_id !== source.runId || producer.head_sha !== source.sourceSha) {
      throw new Error(
        `Distribution producer: expected run ${source.runId} source ${source.sourceSha}; received ${JSON.stringify(producer)}`
      );
    }
  }
  const eligible = producers.filter((job) => Number(job.run_attempt) <= source.runAttempt);
  eligible.sort((left, right) => Number(right.run_attempt) - Number(left.run_attempt));
  const producer = eligible[0];
  if (!producer || eligible[1]?.run_attempt === producer.run_attempt) {
    throw new Error(
      `Distribution producer: expected one latest builder through frozen attempt ${source.runAttempt}; received ${JSON.stringify(eligible)}`
    );
  }
  if (producer.status !== 'completed' || producer.conclusion !== 'success') {
    throw new Error(
      `Distribution producer: expected completed successful builder; received ${JSON.stringify(producer)}`
    );
  }
  const started = timestamp(producer.started_at, 'started_at');
  const completed = timestamp(producer.completed_at, 'completed_at');
  if (completed < started) {
    throw new Error(
      `Distribution producer: expected ordered timestamps; received ${JSON.stringify(producer)}`
    );
  }
  const artifacts = api.list(`${base}/runs/${source.runId}/artifacts?per_page=100`, 'artifacts');
  for (const artifact of artifacts) {
    const metadata = object(artifact, 'Distribution artifact');
    if (typeof metadata.name !== 'string') {
      throw new Error(
        `Distribution artifact name: expected string; received ${JSON.stringify(metadata.name)}`
      );
    }
  }
  return resolveCanaryDistribution(
    { ...source, producerAttempt: integer(producer.run_attempt, 'Distribution producer attempt') },
    version,
    {
      run: rawRun as unknown as ArtifactEvidence['run'],
      jobs: eligible as unknown as ArtifactEvidence['jobs'],
      artifacts: artifacts as ArtifactEvidence['artifact'][],
    }
  );
}
