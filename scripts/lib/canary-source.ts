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

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected workflow run object, received: ${JSON.stringify(value)}`);
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
    .map(record)
    .filter((run) => run.status === 'completed' && run.conclusion === 'success');
  if (candidates.length === 0) throw new Error('No eligible completed successful main push CI run');
  const sources = candidates.map((run): CanarySource => {
    const runId = positiveInteger(run.id, 'id');
    const runRepository = record(run.repository).full_name;
    const headRepository = record(run.head_repository).full_name;
    const workflowPath = '.github/workflows/ci.yml';
    const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
    if (
      runRepository !== repository ||
      headRepository !== repository ||
      run.workflow_id !== workflowId ||
      run.path !== workflowPath ||
      run.event !== 'push' ||
      run.head_branch !== 'main' ||
      run.html_url !== runUrl
    ) {
      throw new Error(
        `Inconsistent CI run ${runId}: expected ${repository} ${workflowPath} (${workflowId}) push main at ${runUrl}; received ${JSON.stringify(run)}`
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
      runNumber: positiveInteger(run.run_number, 'run_number'),
      sourceSha: run.head_sha,
      repository,
      workflowId,
      workflowPath,
      runUrl,
    };
  });
  sources.sort((left, right) => right.runNumber - left.runNumber);
  if (sources.length > 1 && sources[0]?.runNumber === sources[1]?.runNumber) {
    throw new Error(`Ambiguous CI run_number: ${sources[0]?.runNumber}; expected unique push run`);
  }
  const selected = sources[0];
  if (!selected) throw new Error('No eligible completed successful main push CI run');
  return selected;
}
