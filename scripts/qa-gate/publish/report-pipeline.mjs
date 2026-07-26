// Trusted-side input resolution for the PR QA report publisher. Runs inside
// actions/github-script on a default-branch checkout with a write-capable
// token, so every value it derives comes from the GitHub API — never from
// artifact content, which stays untrusted until render-report.ts validates it
// against the report context this module produces.

/** Artifact name shared with the collector (pinned to metrics-envelope.ts by test). */
export const QA_METRICS_ARTIFACT_NAME = 'qa-metrics';

/** Hard cap on the downloaded artifact archive; larger uploads are ignored. */
export const MAX_ARTIFACT_ARCHIVE_BYTES = 2 * 1024 * 1024;

/** Workflow whose runs collect metrics (PR heads) and baselines (main pushes). */
export const CI_WORKFLOW_FILE = 'ci.yml';

async function findOpenPullRequest(github, context, run) {
  const headOwner = run.head_repository?.owner?.login;
  if (!headOwner || !run.head_branch || !run.head_sha) return null;
  const pullRequests = await github.paginate(github.rest.pulls.list, {
    ...context.repo,
    state: 'open',
    head: `${headOwner}:${run.head_branch}`,
    per_page: 100,
  });
  return pullRequests.find((pullRequest) => pullRequest.head.sha === run.head_sha) ?? null;
}

async function downloadMetricsArchive(github, context, runId) {
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    ...context.repo,
    run_id: runId,
    per_page: 100,
  });
  const artifact = artifacts.find(
    (candidate) => candidate.name === QA_METRICS_ARTIFACT_NAME && !candidate.expired
  );
  if (!artifact) return { archive: null, reason: 'run has no qa-metrics artifact' };
  if (artifact.size_in_bytes > MAX_ARTIFACT_ARCHIVE_BYTES) {
    return {
      archive: null,
      reason: `qa-metrics artifact exceeds ${MAX_ARTIFACT_ARCHIVE_BYTES} bytes`,
    };
  }

  const response = await github.rest.actions.downloadArtifact({
    ...context.repo,
    artifact_id: artifact.id,
    archive_format: 'zip',
  });
  const archive = new Uint8Array(response.data);
  if (archive.byteLength > MAX_ARTIFACT_ARCHIVE_BYTES) {
    return { archive: null, reason: 'downloaded archive exceeded the size limit' };
  }
  return { archive, reason: null };
}

async function findBaselineRun(github, context, baseSha) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...context.repo,
    workflow_id: CI_WORKFLOW_FILE,
    head_sha: baseSha,
    event: 'push',
    status: 'success',
    per_page: 10,
  });
  return data.workflow_runs?.[0] ?? null;
}

const boundedText = (value, maxLength, fallback) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return (text || fallback).slice(0, maxLength);
};

const errorMessage = (error, prefix = '') => {
  const message = error instanceof Error ? error.message : String(error);
  return boundedText(`${prefix}${message}`, 2000, 'unknown Actions API error');
};

const unavailableDurations = (runId, error) => ({ runId, error, jobs: [] });

/** Mirrors the `jobs` maxItems bound in scripts/qa-gate/ci-durations.ts (pinned by test). */
export const MAX_CI_JOBS = 500;

/**
 * Collect job timestamps from the privileged publisher side. Failures stay
 * inside the report as data so duration visibility can never block the PR.
 */
export async function collectCiDurations(github, context, runId) {
  if (!runId) return unavailableDurations(null, 'workflow run is unavailable');
  try {
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...context.repo,
      run_id: runId,
      filter: 'latest',
      per_page: 100,
    });
    return {
      runId,
      error: null,
      // Truncate rather than overflow the schema bound: an oversized matrix
      // would otherwise fail validation and drop every run from the report.
      jobs: jobs.slice(0, MAX_CI_JOBS).map((job) => ({
        name: boundedText(job.name, 500, 'unnamed job'),
        status: boundedText(job.status, 40, 'unknown'),
        conclusion: job.conclusion === null ? null : boundedText(job.conclusion, 40, 'unknown'),
        startedAt: typeof job.started_at === 'string' ? job.started_at.slice(0, 64) : null,
        completedAt: typeof job.completed_at === 'string' ? job.completed_at.slice(0, 64) : null,
      })),
    };
  } catch (error) {
    return unavailableDurations(runId, errorMessage(error, 'Actions jobs API failed: '));
  }
}

async function findPreviousPullRequestRun(github, context, run, pullRequest) {
  const headOwner = run.head_repository?.owner?.login;
  try {
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...context.repo,
      workflow_id: CI_WORKFLOW_FILE,
      branch: run.head_branch,
      event: 'pull_request',
      // `completed` would also match runs this workflow's own concurrency group
      // cancelled mid-flight, whose wall clock is a truncated fragment.
      status: 'success',
      per_page: 100,
    });
    const previous = data.workflow_runs?.find(
      (candidate) =>
        candidate.id !== run.id &&
        candidate.id < run.id &&
        (candidate.pull_requests?.some((pull) => pull.number === pullRequest.number) ||
          // Runs triggered by a fork pull request carry an empty `pull_requests`
          // array, so fall back to the head identity the branch filter alone
          // cannot disambiguate.
          (Boolean(headOwner) &&
            candidate.head_repository?.owner?.login === headOwner &&
            candidate.head_branch === run.head_branch))
    );
    return previous
      ? { run: previous, error: null }
      : { run: null, error: 'no previous successful CI run found for this pull request' };
  } catch (error) {
    return { run: null, error: errorMessage(error, 'previous CI run lookup failed: ') };
  }
}

/**
 * Resolve everything the publisher needs from trusted API data: the open PR
 * matching the triggering run's exact head SHA, the head qa-metrics archive
 * from that run, and the baseline archive from the successful main-push CI
 * run for the PR's base SHA (exact-base only — a missing baseline is reported
 * as unavailable, never approximated).
 *
 * Returns `{ skip }` when there is nothing to publish (non-PR run, stale head,
 * or closed PR).
 *
 * // Usage: await resolveReportInputs({ github, context })
 */
export async function resolveReportInputs({ github, context }) {
  const run = context.payload.workflow_run;
  if (run?.event !== 'pull_request') {
    return { skip: 'triggering run is not a pull_request run' };
  }

  const pullRequest = await findOpenPullRequest(github, context, run);
  if (!pullRequest) {
    return { skip: `no open pull request with head ${run.head_sha}; stale run or closed PR` };
  }

  const head = await downloadMetricsArchive(github, context, run.id);
  const [baselineRun, previousRun] = await Promise.all([
    findBaselineRun(github, context, pullRequest.base.sha),
    findPreviousPullRequestRun(github, context, run, pullRequest),
  ]);
  const base = baselineRun
    ? await downloadMetricsArchive(github, context, baselineRun.id)
    : { archive: null, reason: `no successful main CI run found for base ${pullRequest.base.sha}` };
  const [headDurations, baseDurations, previousDurations] = await Promise.all([
    collectCiDurations(github, context, run.id),
    baselineRun
      ? collectCiDurations(github, context, baselineRun.id)
      : unavailableDurations(
          null,
          `no successful main CI run found for base ${pullRequest.base.sha}`
        ),
    previousRun.run
      ? collectCiDurations(github, context, previousRun.run.id)
      : unavailableDurations(null, previousRun.error),
  ]);

  return {
    skip: null,
    headArchive: head.archive,
    baseArchive: base.archive,
    ciDurations: {
      base: baseDurations,
      head: headDurations,
      previous: previousDurations,
    },
    reportContext: {
      repository: `${context.repo.owner}/${context.repo.repo}`,
      prNumber: pullRequest.number,
      headSha: run.head_sha,
      baseSha: pullRequest.base.sha,
      runUrl: run.html_url,
      headArtifact: { found: head.archive !== null, reason: head.reason },
      baseArtifact: { found: base.archive !== null, reason: base.reason },
    },
  };
}
