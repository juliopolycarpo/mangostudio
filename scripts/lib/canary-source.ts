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

/**
 * Days a main push CI run stays promotable. Pinned to the push value of
 * `publication_retention_days` in `.github/workflows/ci.yml`: after that the
 * run's distribution bundles have expired, so Canary cannot promote it.
 */
export const CANARY_SOURCE_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Oldest `created_at` a source run may have at `now`, second precision. Example: canarySourceWindowStart(new Date('2026-11-13T06:17:00Z')). */
export function canarySourceWindowStart(now: Date): string {
  if (!Number.isFinite(now.getTime()))
    throw new Error(`Invalid canary source clock: expected valid Date; received ${String(now)}`);
  const start = new Date(now.getTime() - CANARY_SOURCE_WINDOW_DAYS * DAY_MS);
  return start.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The one query both source resolvers use to list selectable CI runs: successful
 * main pushes created inside the retention window. `since` goes back to
 * `selectCanarySource` so the error names the window it searched.
 * Example: canarySourceRunsQuery('repos/o/r', 42, now).path.
 */
export function canarySourceRunsQuery(
  repositoryPath: string,
  workflowId: number | string,
  now: Date
): { readonly path: string; readonly since: string } {
  const since = canarySourceWindowStart(now);
  return {
    path: `${repositoryPath}/actions/workflows/${workflowId}/runs?branch=main&event=push&status=success&per_page=100&created=>=${since}`,
    since,
  };
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

function noEligibleRun(since: string | undefined): Error {
  return new Error(
    `No eligible CI source | expected a completed successful main push CI run${since === undefined ? '' : ` created since ${since}`} | received: none`
  );
}

/**
 * Freeze the newest original push run, independent of rerun completion time.
 * Validate ordering for every success and identity only for the winner; never
 * fall through to an older source when the winner is invalid. With `since`, the
 * winner must also have been created inside the window: the check follows the
 * ranking, so an expired winner never yields to an older run.
 * Example: selectCanarySource(runs, 'owner/repo', 123, { since: '2026-10-14T06:17:00Z' }).
 */
export function selectCanarySource(
  runs: readonly unknown[],
  repository: string,
  workflowId: number,
  window: { readonly since?: string } = {}
): CanarySource {
  const { since } = window;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`Invalid repository: ${repository}; expected owner/repository`);
  }
  positiveInteger(workflowId, 'workflow_id');
  const candidates = runs
    .map((value) => record(value))
    .filter((run) => run.status === 'completed' && run.conclusion === 'success');
  if (candidates.length === 0) throw noEligibleRun(since);
  const ranked = candidates
    .map((run) => ({ run, runNumber: positiveInteger(run.run_number, 'run_number') }))
    .sort((left, right) => right.runNumber - left.runNumber);
  if (ranked.length > 1 && ranked[0]?.runNumber === ranked[1]?.runNumber) {
    throw new Error(`Ambiguous CI run_number: ${ranked[0]?.runNumber}; expected unique push run`);
  }
  const selected = ranked[0];
  if (!selected) throw noEligibleRun(since);
  const { run, runNumber } = selected;
  const runId = positiveInteger(run.id, 'id');
  if (since !== undefined) {
    const created = typeof run.created_at === 'string' ? Date.parse(run.created_at) : Number.NaN;
    if (!Number.isFinite(created))
      throw new Error(
        `Invalid created_at of CI run ${runId}: expected ISO timestamp; received ${JSON.stringify(run.created_at)}`
      );
    if (created < Date.parse(since))
      throw new Error(
        `CI run ${runId} outside source window: expected created since ${since} | received: ${String(run.created_at)}`
      );
  }
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
