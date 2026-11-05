/** Metadata frozen before any canary build or publication starts. */
export interface CanarySource {
  readonly runId: number;
  readonly runAttempt: number;
  readonly runNumber: number;
  readonly sourceSha: string;
  readonly repository: string;
  readonly workflowId: number;
  readonly workflowPath: string;
  readonly runUrl: string;
}

function record(value: unknown, field = 'workflow run'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${field} object, received: ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${field}: ${JSON.stringify(value)}; expected positive safe integer`);
  }
  return value;
}

/**
 * Freeze the newest original push run, independent of rerun completion time.
 * Validate ordering for every success and identity only for the winner; never
 * fall through to an older source when the winner is invalid.
 * Example: selectCanarySource(runs, 'owner/repo', 123).
 */
export function selectCanarySource(
  runs: readonly unknown[],
  repository: string,
  workflowId: number
): CanarySource {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Invalid repository: ${repository}; expected owner/repository`);
  }
  positiveInteger(workflowId, 'workflow_id');
  const candidates = runs
    .map((value) => record(value))
    .filter((run) => run.status === 'completed' && run.conclusion === 'success');
  if (candidates.length === 0) throw new Error('No eligible completed successful main push CI run');
  const ranked = candidates
    .map((run) => ({ run, runNumber: positiveInteger(run.run_number, 'run_number') }))
    .sort((left, right) => right.runNumber - left.runNumber);
  if (ranked.length > 1 && ranked[0]?.runNumber === ranked[1]?.runNumber) {
    throw new Error(`Ambiguous CI run_number: ${ranked[0]?.runNumber}; expected unique push run`);
  }
  const selected = ranked[0];
  if (!selected) throw new Error('No eligible completed successful main push CI run');
  const { run, runNumber } = selected;
  const runId = positiveInteger(run.id, 'id');
  const runRepository = record(run.repository, `CI run ${runId} repository`).full_name;
  const headRepository = record(run.head_repository, `CI run ${runId} head_repository`).full_name;
  const workflowPath = '.github/workflows/ci.yml';
  const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  const received: Record<string, unknown> = {
    repository: runRepository,
    head_repository: headRepository,
    workflow_id: run.workflow_id,
    path: run.path,
    event: run.event,
    head_branch: run.head_branch,
    html_url: run.html_url,
  };
  const expected: Record<string, unknown> = {
    repository,
    head_repository: repository,
    workflow_id: workflowId,
    path: workflowPath,
    event: 'push',
    head_branch: 'main',
    html_url: runUrl,
  };
  const mismatches = Object.fromEntries(
    Object.entries(expected)
      .filter(([field, value]) => received[field] !== value)
      .map(([field, value]) => [field, { expected: value, received: received[field] }])
  );
  if (Object.keys(mismatches).length > 0) {
    throw new Error(
      `Inconsistent CI run ${runId}: expected ${repository} ${workflowPath} (${workflowId}) push main at ${runUrl}; mismatched fields ${JSON.stringify(mismatches)}`
    );
  }
  if (typeof run.head_sha !== 'string' || !/^[0-9a-f]{40}$/.test(run.head_sha)) {
    throw new Error(
      `Invalid head_sha: ${JSON.stringify(run.head_sha)}; expected full lowercase 40-character SHA`
    );
  }
  return {
    runId,
    runAttempt: positiveInteger(run.run_attempt, 'run_attempt'),
    runNumber,
    sourceSha: run.head_sha,
    repository,
    workflowId,
    workflowPath,
    runUrl,
  };
}
