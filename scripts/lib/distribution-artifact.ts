/** Frozen identity supplied by the source-selection job. */
export interface ApprovedArtifact {
  readonly repository: string;
  readonly sourceSha: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly producerAttempt: number;
  readonly artifactId: number;
  readonly artifactName: string;
  readonly digest: string;
}

/** GitHub REST metadata needed to bind an artifact to its approved producer. */
export interface ArtifactEvidence {
  readonly run: {
    readonly id: number;
    readonly run_attempt: number;
    readonly path: string;
    readonly event: string;
    readonly head_branch: string;
    readonly head_sha: string;
    readonly status: string;
    readonly conclusion: string;
    readonly repository: { readonly id: number; readonly full_name: string };
    readonly head_repository: { readonly id: number; readonly full_name: string };
  };
  readonly artifact: {
    readonly id: number;
    readonly name: string;
    readonly digest: string;
    readonly expired: boolean;
    readonly created_at: string;
    readonly workflow_run: {
      readonly id: number;
      readonly repository_id: number;
      readonly head_repository_id: number;
      readonly head_sha: string;
      readonly head_branch: string;
    };
  };
  readonly jobs: readonly {
    readonly name: string;
    readonly run_id: number;
    readonly run_attempt: number;
    readonly conclusion: string;
    readonly started_at: string;
    readonly completed_at: string;
  }[];
}

/**
 * Reject metadata outside the approved main CI distribution, including rerun drift.
 * Usage: validateArtifactEvidence(approval, { run, artifact, jobs });
 */
export function validateArtifactEvidence(
  approval: ApprovedArtifact,
  evidence: ArtifactEvidence
): void {
  const { run, artifact, jobs } = evidence;
  const fail = (field: string, value: unknown, expected: unknown): never => {
    throw new Error(
      `Distribution ${field}: expected ${String(expected)} | received ${String(value)}`
    );
  };
  if (!run?.repository || !run.head_repository || !artifact?.workflow_run || !Array.isArray(jobs)) {
    fail(
      'metadata',
      JSON.stringify(evidence),
      'run repository, artifact workflow_run and jobs array'
    );
  }
  for (const [field, value] of Object.entries({
    runId: approval.runId,
    runAttempt: approval.runAttempt,
    producerAttempt: approval.producerAttempt,
    artifactId: approval.artifactId,
    repositoryId: run.repository.id,
    headRepositoryId: run.head_repository.id,
    artifactRepositoryId: artifact.workflow_run.repository_id,
    artifactHeadRepositoryId: artifact.workflow_run.head_repository_id,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) fail(field, value, 'positive safe integer');
  }
  if (!/^[a-f0-9]{40}$/.test(approval.sourceSha))
    fail('source SHA', approval.sourceSha, 'full lowercase SHA');
  if (!/^sha256:[a-f0-9]{64}$/.test(approval.digest))
    fail('digest', approval.digest, 'sha256:<64 lowercase hex>');
  if (approval.producerAttempt > approval.runAttempt)
    fail('producer attempt', approval.producerAttempt, `<= ${approval.runAttempt}`);
  const comparisons: readonly [string, unknown, unknown][] = [
    ['repository', run.repository.full_name, approval.repository],
    ['head repository', run.head_repository.id, run.repository.id],
    ['head repository name', run.head_repository.full_name, approval.repository],
    ['run ID', run.id, approval.runId],
    ['run attempt', run.run_attempt, approval.runAttempt],
    ['workflow', run.path, '.github/workflows/ci.yml'],
    ['event', run.event, 'push'],
    ['branch', run.head_branch, 'main'],
    ['source SHA', run.head_sha, approval.sourceSha],
    ['status', run.status, 'completed'],
    ['conclusion', run.conclusion, 'success'],
    ['artifact ID', artifact.id, approval.artifactId],
    ['artifact name', artifact.name, approval.artifactName],
    ['artifact digest', artifact.digest, approval.digest],
    ['artifact expired', artifact.expired, false],
    ['artifact run ID', artifact.workflow_run.id, approval.runId],
    ['artifact repository', artifact.workflow_run.repository_id, run.repository.id],
    ['artifact head repository', artifact.workflow_run.head_repository_id, run.repository.id],
    ['artifact SHA', artifact.workflow_run.head_sha, approval.sourceSha],
    ['artifact branch', artifact.workflow_run.head_branch, 'main'],
  ];
  for (const [field, value, expected] of comparisons) {
    if (value !== expected) fail(field, value, expected);
  }
  // A successful final rerun may reuse earlier successful jobs. Require explicit
  // evidence from that earlier attempt; artifact metadata has no attempt field.
  const created = Date.parse(artifact.created_at);
  const producers = jobs.filter(
    (job) =>
      job.name === 'Distribution / Build immutable distribution' &&
      job.run_id === approval.runId &&
      job.run_attempt === approval.producerAttempt &&
      job.conclusion === 'success' &&
      Number.isFinite(created) &&
      Date.parse(job.started_at) <= created &&
      created <= Date.parse(job.completed_at)
  );
  if (producers.length !== 1) fail('successful producing jobs', producers.length, 1);
}

/**
 * Select the sole flat bundle member without extracting arbitrary ZIP paths.
 * Usage: distributionBundleMember('npm.tar.gz\n') === 'npm.tar.gz'.
 */
export function distributionBundleMember(listing: string): string {
  const members = listing.replace(/\r?\n$/, '').split('\n');
  const member = members[0] ?? '';
  if (members.length !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tar(?:\.gz)?$/.test(member)) {
    throw new Error(
      `Distribution ZIP members: expected one flat .tar or .tar.gz bundle | received ${JSON.stringify(members)}`
    );
  }
  return member;
}
