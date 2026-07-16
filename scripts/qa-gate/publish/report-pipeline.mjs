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
  const baselineRun = await findBaselineRun(github, context, pullRequest.base.sha);
  const base = baselineRun
    ? await downloadMetricsArchive(github, context, baselineRun.id)
    : { archive: null, reason: `no successful main CI run found for base ${pullRequest.base.sha}` };

  return {
    skip: null,
    headArchive: head.archive,
    baseArchive: base.archive,
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
