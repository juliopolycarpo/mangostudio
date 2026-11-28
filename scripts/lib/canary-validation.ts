import { readFileSync } from 'node:fs';

import { rustCoverageFromGitHub } from './canary-codeql-coverage';
import { touchesProtocolSurface } from './protocol';
import { classifyChangedPaths } from './rust-lanes';

/** Frozen selection supplied by the canary source job. */
export interface CanaryValidationSource {
  readonly repository: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly sourceSha: string;
  /** Exact push before SHA supplied only after verifying the CI push-context artifact. */
  readonly pushBeforeSha?: string;
}

/** Project-owned GitHub API boundary; implementations must reject failed/incomplete reads. */
export interface CanaryValidationApi {
  get(path: string): unknown;
  list(path: string, key: string): readonly unknown[];
}

interface JobReceipt {
  readonly id: number;
  readonly name: string;
  readonly attempt: number;
}

/** Evidence retained by the publication summary and artifact resolver. */
export interface CanaryValidationReceipt {
  readonly source: CanaryValidationSource;
  readonly builderAttempt: number;
  readonly ciJobs: readonly JobReceipt[];
  readonly siblings: readonly {
    readonly workflow: string;
    readonly runId: number | null;
    readonly attempt: number | null;
    readonly result: 'success' | 'not-triggered';
    readonly jobs: readonly JobReceipt[];
  }[];
  readonly relevance: {
    readonly cargo: boolean;
    readonly protocol: boolean;
    readonly reason: string;
  };
  /**
   * How the CodeQL Rust analyses cover the source. Absent in receipts written
   * before the Rust legs could be skipped; those always analyzed the SHA.
   */
  readonly codeqlRust?: {
    /** True when both Rust legs succeeded on the source SHA itself. */
    readonly analyzed: boolean;
    readonly reason: string;
  };
}

function object(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description}: expected object; received ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, description: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${description}: expected positive safe integer; received ${JSON.stringify(value)}`
    );
  }
  return value;
}

function validateRun(
  value: unknown,
  source: CanaryValidationSource,
  workflow: string,
  workflowId: number
): Record<string, unknown> {
  const run = object(value, workflow);
  const expectedPath = `.github/workflows/${workflow}`;
  const valid =
    run.workflow_id === workflowId &&
    run.path === expectedPath &&
    object(run.repository, `${workflow} repository`).full_name === source.repository &&
    object(run.head_repository, `${workflow} head_repository`).full_name === source.repository &&
    run.head_sha === source.sourceSha &&
    run.event === 'push' &&
    run.head_branch === 'main' &&
    run.status === 'completed' &&
    run.conclusion === 'success';
  if (!valid) {
    throw new Error(
      `${workflow}: expected completed successful ${source.repository} main push ${source.sourceSha} from workflow ${workflowId}; received ${JSON.stringify(run)}`
    );
  }
  integer(run.id, `${workflow} run ID`);
  integer(run.run_attempt, `${workflow} run attempt`);
  integer(run.run_number, `${workflow} run number`);
  return run;
}

function listRunJobs(
  api: CanaryValidationApi,
  repository: string,
  runId: number
): Record<string, unknown>[] {
  return api
    .list(`repos/${repository}/actions/runs/${runId}/jobs?filter=all&per_page=100`, 'jobs')
    .map((job) => object(job, `run ${runId} job`));
}

/** Newest attempt of a named job through `attempt`; undefined when the run has none. */
function latestJob(
  jobs: readonly Record<string, unknown>[],
  runId: number,
  attempt: number,
  name: string
): Record<string, unknown> | undefined {
  const eligible = jobs
    .filter((job) => job.name === name)
    .filter((job) => integer(job.run_attempt, `${name} attempt`) <= attempt);
  eligible.sort((left, right) => Number(right.run_attempt) - Number(left.run_attempt));
  if (eligible[1] && eligible[0]?.run_attempt === eligible[1].run_attempt) {
    throw new Error(
      `run ${runId} ${name}: expected exactly one latest producer through attempt ${attempt}; received ${JSON.stringify(eligible)}`
    );
  }
  return eligible[0];
}

function successfulJobReceipt(
  latest: Record<string, unknown>,
  runId: number,
  name: string
): JobReceipt {
  if (latest.status !== 'completed' || latest.conclusion !== 'success' || latest.run_id !== runId) {
    throw new Error(
      `run ${runId} ${name}: expected completed successful associated job; received ${JSON.stringify(latest)}`
    );
  }
  return {
    id: integer(latest.id, `${name} job ID`),
    name,
    attempt: integer(latest.run_attempt, `${name} attempt`),
  };
}

function requireJobs(
  api: CanaryValidationApi,
  repository: string,
  runId: number,
  attempt: number,
  names: readonly string[]
): JobReceipt[] {
  const jobs = listRunJobs(api, repository, runId);
  return names.map((name) => {
    const latest = latestJob(jobs, runId, attempt, name);
    if (!latest) {
      throw new Error(
        `run ${runId} ${name}: expected exactly one latest producer through attempt ${attempt}; received []`
      );
    }
    return successfulJobReceipt(latest, runId, name);
  });
}

const CODEQL_RUST_JOBS = ['Analyze (rust)', 'Analyze (rust, windows)'] as const;

/**
 * Settle the two CodeQL Rust legs of a successful codeql.yml run. Both
 * succeeded: analyzed on this SHA. Both were skipped by the workflow's
 * relevance rule: accepted only when main's recorded Rust analyses cover the
 * SHA, recomputed here instead of trusted from the run. Anything else is a
 * partial or failed Rust verdict and fails closed.
 */
function settleCodeqlRust(
  api: CanaryValidationApi,
  source: CanaryValidationSource,
  runId: number,
  attempt: number
): { jobs: JobReceipt[]; codeqlRust: NonNullable<CanaryValidationReceipt['codeqlRust']> } {
  const runJobs = listRunJobs(api, source.repository, runId);
  // A leg skipped by a job-level `if` can carry an unexpanded matrix name, so
  // absence of the named job counts as skipped, never as a failure to find it.
  const latest = CODEQL_RUST_JOBS.map((name) => latestJob(runJobs, runId, attempt, name));
  const skipped = latest.map((job) => job === undefined || job.conclusion === 'skipped');
  if (skipped.every((isSkipped) => !isSkipped)) {
    return {
      jobs: CODEQL_RUST_JOBS.map((name, index) =>
        successfulJobReceipt(latest[index] as Record<string, unknown>, runId, name)
      ),
      codeqlRust: { analyzed: true, reason: `both Rust analyses ran on ${source.sourceSha}` },
    };
  }
  if (!skipped.every(Boolean)) {
    throw new Error(
      `codeql.yml run ${runId}: expected both Rust analyses to succeed or both to be skipped; received ${JSON.stringify(latest)}`
    );
  }
  // The relevance pattern decides what "no Rust change" means. Trust it only
  // when the source carries the same predicate as this qualification revision.
  const predicatePath = 'scripts/lib/ci-lanes.ts';
  const predicate = object(
    api.get(`repos/${source.repository}/contents/${predicatePath}?ref=${source.sourceSha}`),
    `source ${predicatePath}`
  );
  const expectedPredicate = readFileSync(
    new URL(`../../${predicatePath}`, import.meta.url),
    'utf8'
  );
  if (
    predicate.encoding !== 'base64' ||
    typeof predicate.content !== 'string' ||
    Buffer.from(predicate.content, 'base64').toString('utf8') !== expectedPredicate
  ) {
    throw new Error(
      `codeql.yml run ${runId}: Rust analyses were skipped but ${predicatePath} at ${source.sourceSha} differs from the qualification revision; expected identical relevance predicate bytes or both Rust analyses on the SHA`
    );
  }
  const coverage = rustCoverageFromGitHub(api, source.repository, source.sourceSha);
  if (!coverage.covered) {
    throw new Error(
      `codeql.yml run ${runId}: Rust analyses were skipped for ${source.sourceSha} but no earlier or later main analysis covers it; expected a commit with ${CODEQL_RUST_JOBS.join(' and ')} analyses and no CodeQL-Rust-relevant path difference; received ${coverage.reason}`
    );
  }
  return { jobs: [], codeqlRust: { analyzed: false, reason: coverage.reason } };
}

const CI_REQUIRED_JOBS = [
  'CI Gate',
  'Distribution / Build immutable distribution',
  'Smoke — Binary / Binary linux-x64',
  'Smoke — Binary / Binary linux-arm64',
  'Smoke — Binary / Binary darwin-x64',
  'Smoke — Binary / Binary darwin-arm64',
  'Smoke — Binary / Binary windows-x64',
  'Smoke — Binary / Binary windows-arm64',
  'Smoke — Container / Container transport',
] as const;

function relevance(
  api: CanaryValidationApi,
  source: CanaryValidationSource
): CanaryValidationReceipt['relevance'] {
  // Absence requires the exact push event's before SHA from an approved
  // source-associated receipt. A prior observed run can skip pushes or deleted
  // runs, so its SHA cannot prove this event's path-filter range.
  const unknown = {
    cargo: true,
    protocol: true,
    reason: 'exact push range unproven; require both sibling workflows',
  };
  if (!source.pushBeforeSha) return unknown;
  for (const path of ['scripts/lib/rust-lanes.ts', 'scripts/lib/protocol.ts']) {
    const content = object(
      api.get(`repos/${source.repository}/contents/${path}?ref=${source.sourceSha}`),
      `source ${path}`
    );
    const expected = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    if (
      content.encoding !== 'base64' ||
      typeof content.content !== 'string' ||
      Buffer.from(content.content, 'base64').toString('utf8') !== expected
    ) {
      return {
        cargo: true,
        protocol: true,
        reason: `${path} differs from qualification policy; require both sibling workflows`,
      };
    }
  }
  const comparison = object(
    api.get(`repos/${source.repository}/compare/${source.pushBeforeSha}...${source.sourceSha}`),
    'push comparison'
  );
  // A history rewrite may preserve the entire tree while losing ancestry.
  // The compare endpoint lists merge-base changes in that case, so only exact
  // commit-bound root-tree identity can prove the push changed no inputs.
  if (comparison.status === 'diverged') {
    const trees = [source.pushBeforeSha, source.sourceSha].map((sha) => {
      const commit = object(
        api.get(`repos/${source.repository}/git/commits/${sha}`),
        `push commit ${sha}`
      );
      const tree = object(commit.tree, `push commit ${sha} tree`).sha;
      if (commit.sha !== sha || typeof tree !== 'string' || !/^[a-f0-9]{40}$/.test(tree)) {
        throw new Error(
          `push tree proof: expected commit ${sha} and full root tree SHA; received ${JSON.stringify(commit)}`
        );
      }
      return tree;
    });
    if (trees[0] === trees[1]) {
      return {
        cargo: false,
        protocol: false,
        reason: `verified push ${source.pushBeforeSha}...${source.sourceSha}: identical root trees ${trees[0]}`,
      };
    }
  }
  if (
    (comparison.truncated !== undefined && comparison.truncated !== false) ||
    !['ahead', 'identical'].includes(String(comparison.status)) ||
    object(comparison.base_commit, 'comparison base').sha !== source.pushBeforeSha ||
    object(comparison.merge_base_commit, 'comparison merge base').sha !== source.pushBeforeSha ||
    !Array.isArray(comparison.files) ||
    comparison.files.length >= 300
  )
    return unknown;
  // The API proves an exact empty range; a bare empty CLI path list cannot
  // make this claim, so do not send it through the conservative CLI predicate.
  if (comparison.files.length === 0)
    return {
      cargo: false,
      protocol: false,
      reason: `verified exact push comparison ${source.pushBeforeSha}...${source.sourceSha}: no net file changes`,
    };
  const paths: string[] = [];
  for (const entry of comparison.files) {
    const file = object(entry, 'changed file');
    if (
      typeof file.filename !== 'string' ||
      (file.status === 'renamed' && typeof file.previous_filename !== 'string')
    )
      return unknown;
    paths.push(file.filename);
    if (typeof file.previous_filename === 'string') paths.push(file.previous_filename);
  }
  return {
    cargo: classifyChangedPaths(paths).qualification,
    protocol: touchesProtocolSurface(paths),
    reason: `verified exact push comparison ${source.pushBeforeSha}...${source.sourceSha}`,
  };
}

/**
 * Qualify a frozen CI run and its same-source sibling producers before promotion.
 * Example: qualifyCanarySource({ repository: 'owner/repo', runId: 1, runAttempt: 1, sourceSha }, api).
 */
export function qualifyCanarySource(
  source: CanaryValidationSource,
  api: CanaryValidationApi
): CanaryValidationReceipt {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository) ||
    !/^[a-f0-9]{40}$/.test(source.sourceSha)
  ) {
    throw new Error(
      `Invalid frozen canary source: expected owner/repository and full source SHA; received ${JSON.stringify(source)}`
    );
  }
  if (source.pushBeforeSha !== undefined && !/^[a-f0-9]{40}$/.test(source.pushBeforeSha)) {
    throw new Error(
      `Invalid verified push before SHA: ${source.pushBeforeSha}; expected full 40-character SHA`
    );
  }
  integer(source.runId, 'selected run ID');
  integer(source.runAttempt, 'selected run attempt');
  // Job names alone cannot establish that an older workflow exercised the
  // current smoke matrix or gate policy. Require the reviewed producer contract.
  for (const workflow of [
    'ci.yml',
    'distribution-build.yml',
    'smoke-binary.yml',
    'smoke-container.yml',
    'cargo-shim.yml',
    'protocol-ci.yml',
    'codeql.yml',
  ]) {
    const path = `.github/workflows/${workflow}`;
    const content = object(
      api.get(`repos/${source.repository}/contents/${path}?ref=${source.sourceSha}`),
      `source ${path}`
    );
    const expected = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
    if (
      content.encoding !== 'base64' ||
      typeof content.content !== 'string' ||
      Buffer.from(content.content, 'base64').toString('utf8') !== expected
    ) {
      throw new Error(
        `${workflow}: source validation contract differs from qualification revision; expected identical reviewed workflow bytes, select a compatible successful source`
      );
    }
  }
  const ciWorkflow = object(
    api.get(`repos/${source.repository}/actions/workflows/ci.yml`),
    'CI workflow'
  );
  const ciWorkflowId = integer(ciWorkflow.id, 'CI workflow ID');
  const ci = validateRun(
    api.get(
      `repos/${source.repository}/actions/runs/${source.runId}/attempts/${source.runAttempt}`
    ),
    source,
    'ci.yml',
    ciWorkflowId
  );
  if (ci.id !== source.runId || ci.run_attempt !== source.runAttempt) {
    throw new Error(
      `Frozen CI attempt metadata mismatch: expected ${source.runId} attempt ${source.runAttempt}; received ${JSON.stringify(ci)}`
    );
  }
  const ciJobs = requireJobs(
    api,
    source.repository,
    source.runId,
    source.runAttempt,
    CI_REQUIRED_JOBS
  );
  const builderAttempt = ciJobs.find(
    (job) => job.name === 'Distribution / Build immutable distribution'
  )?.attempt;
  if (!builderAttempt) throw new Error('Missing successful immutable distribution builder attempt');
  for (const job of ciJobs) {
    if (job.attempt < builderAttempt) {
      throw new Error(
        `${job.name}: attempt ${job.attempt} predates distribution builder attempt ${builderAttempt}; expected qualification of approved bytes`
      );
    }
  }
  const required = relevance(api, source);
  const siblings: CanaryValidationReceipt['siblings'][number][] = [];
  let codeqlRust: CanaryValidationReceipt['codeqlRust'];
  for (const policy of [
    { workflow: 'cargo-shim.yml', required: required.cargo, jobs: ['Cargo Shim Gate'] },
    { workflow: 'protocol-ci.yml', required: required.protocol, jobs: ['Protocol Gate'] },
    {
      workflow: 'codeql.yml',
      required: true,
      // The Rust legs are settled separately: analyzed here or covered by an
      // earlier analysis (settleCodeqlRust).
      jobs: ['Analyze (javascript-typescript)'],
    },
  ]) {
    const workflow = object(
      api.get(`repos/${source.repository}/actions/workflows/${policy.workflow}`),
      policy.workflow
    );
    const workflowId = integer(workflow.id, `${policy.workflow} ID`);
    const runs = api
      .list(
        `repos/${source.repository}/actions/workflows/${workflowId}/runs?branch=main&event=push&head_sha=${source.sourceSha}&per_page=100`,
        'workflow_runs'
      )
      .map((run) => object(run, policy.workflow))
      .sort(
        (left, right) =>
          integer(right.run_number, 'sibling run number') -
          integer(left.run_number, 'sibling run number')
      );
    if (runs.length > 1 && runs[0]?.run_number === runs[1]?.run_number) {
      throw new Error(
        `${policy.workflow}: ambiguous same-SHA run number ${runs[0]?.run_number}; expected one producer`
      );
    }
    const selected = runs[0];
    if (!selected) {
      if (policy.required)
        throw new Error(
          `${policy.workflow}: expected same-SHA main push validation; received no run (${required.reason})`
        );
      siblings.push({
        workflow: policy.workflow,
        runId: null,
        attempt: null,
        result: 'not-triggered',
        jobs: [],
      });
      continue;
    }
    const run = validateRun(selected, source, policy.workflow, workflowId);
    const runId = integer(run.id, `${policy.workflow} run ID`);
    const attempt = integer(run.run_attempt, `${policy.workflow} attempt`);
    const jobs = requireJobs(api, source.repository, runId, attempt, policy.jobs);
    if (policy.workflow === 'codeql.yml') {
      const rust = settleCodeqlRust(api, source, runId, attempt);
      jobs.push(...rust.jobs);
      codeqlRust = rust.codeqlRust;
    }
    siblings.push({ workflow: policy.workflow, runId, attempt, result: 'success', jobs });
  }
  return { source, builderAttempt, ciJobs, siblings, relevance: required, codeqlRust };
}
