import { readFileSync } from 'node:fs';

import { rustCoverageFromGitHub, workflowCoverageFromGitHub } from './canary-lane-coverage';
import type { CoverageRule } from './codeql-rust-coverage';
import { touchesProtocolSurface } from './protocol';
import { classifyChangedPaths } from './rust-lanes';
import { requireJsonRecord, requirePositiveSafeInteger } from './script-guards';

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
  /**
   * How Cargo Shim and Protocol CI cover the source. Absent in receipts written
   * before a skipped lane had to be covered by an earlier main run; those
   * judged each lane by the source's own push range alone.
   */
  readonly laneCoverage?: {
    readonly cargo: LaneCoverageReceipt;
    readonly protocol: LaneCoverageReceipt;
  };
}

/** Whether a path-filtered lane ran on the source or an earlier main run covers it. */
interface LaneCoverageReceipt {
  /** True when the lane's own run on the source SHA succeeded. */
  readonly ranOnSource: boolean;
  readonly reason: string;
}

function validateRun(
  value: unknown,
  source: CanaryValidationSource,
  workflow: string,
  workflowId: number
): Record<string, unknown> {
  const run = requireJsonRecord(value, workflow);
  const expectedPath = `.github/workflows/${workflow}`;
  const valid =
    run.workflow_id === workflowId &&
    run.path === expectedPath &&
    requireJsonRecord(run.repository, `${workflow} repository`).full_name === source.repository &&
    requireJsonRecord(run.head_repository, `${workflow} head_repository`).full_name ===
      source.repository &&
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
  requirePositiveSafeInteger(run.id, `${workflow} run ID`);
  requirePositiveSafeInteger(run.run_attempt, `${workflow} run attempt`);
  requirePositiveSafeInteger(run.run_number, `${workflow} run number`);
  return run;
}

function listRunJobs(
  api: CanaryValidationApi,
  repository: string,
  runId: number
): Record<string, unknown>[] {
  return api
    .list(`repos/${repository}/actions/runs/${runId}/jobs?filter=all&per_page=100`, 'jobs')
    .map((job) => requireJsonRecord(job, `run ${runId} job`));
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
    .filter((job) => requirePositiveSafeInteger(job.run_attempt, `${name} attempt`) <= attempt);
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
    id: requirePositiveSafeInteger(latest.id, `${name} job ID`),
    name,
    attempt: requirePositiveSafeInteger(latest.run_attempt, `${name} attempt`),
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

/** The Actions run that proves a lane's jobs ran on a candidate commit. */
interface EvidenceLane {
  readonly workflow: string;
  /** Jobs of the latest attempt that must all have succeeded. */
  readonly jobs: readonly string[];
  /** Events whose run may stand in for the lane on a commit. */
  readonly events: readonly string[];
}

// A covering analysis may come from any codeql.yml run on main that analyzes every leg.
const CODEQL_RUST_EVIDENCE: EvidenceLane = {
  workflow: 'codeql.yml',
  jobs: CODEQL_RUST_JOBS,
  events: ['push', 'schedule', 'workflow_dispatch'],
};

function matchesQualificationBytes(
  api: CanaryValidationApi,
  repository: string,
  path: string,
  ref: string
): boolean {
  const content = requireJsonRecord(
    api.get(`repos/${repository}/contents/${path}?ref=${ref}`),
    `${ref} ${path}`
  );
  return (
    content.encoding === 'base64' &&
    typeof content.content === 'string' &&
    Buffer.from(content.content, 'base64').toString('utf8') ===
      readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
  );
}

/** "A or B", "A, B or C" for an event list; the single event itself otherwise. */
function listWith(conjunction: 'and' | 'or', names: readonly string[]): string {
  return names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} ${conjunction} ${names[names.length - 1]}`;
}

/**
 * Actions proof that a candidate commit's lane ran: a completed run of the lane's
 * workflow on main in this repository for that exact SHA, from one of the lane's
 * events, whose latest attempt has every lane job successful, from a workflow
 * file with the qualification revision's bytes. Nominating rows (code scanning
 * analyses, run listings) cannot stand in for it: an uploader picks a SARIF's
 * ref, commit and category, and a listing row says nothing about jobs. Returns
 * undefined when the proof holds, else the missing evidence.
 */
function missingLaneJobEvidence(
  api: CanaryValidationApi,
  repository: string,
  candidate: string,
  lane: EvidenceLane
): string | undefined {
  const path = `.github/workflows/${lane.workflow}`;
  if (!matchesQualificationBytes(api, repository, path, candidate)) {
    return `no Actions evidence: ${path} at ${candidate} differs from the qualification revision`;
  }
  const workflowId = requirePositiveSafeInteger(
    requireJsonRecord(
      api.get(`repos/${repository}/actions/workflows/${lane.workflow}`),
      lane.workflow
    ).id,
    `${lane.workflow} ID`
  );
  const runs = api
    .list(
      `repos/${repository}/actions/workflows/${workflowId}/runs?branch=main&head_sha=${candidate}&per_page=100`,
      'workflow_runs'
    )
    .map((run) => requireJsonRecord(run, `${lane.workflow} candidate run`))
    .filter(
      (run) =>
        run.workflow_id === workflowId &&
        run.path === path &&
        requireJsonRecord(run.repository, 'candidate run repository').full_name === repository &&
        requireJsonRecord(run.head_repository, 'candidate run head repository').full_name ===
          repository &&
        run.head_sha === candidate &&
        run.head_branch === 'main' &&
        lane.events.includes(String(run.event)) &&
        run.status === 'completed'
    );
  if (runs.length === 0) {
    return `no Actions evidence: expected a completed ${lane.workflow} run on main for ${candidate} (${listWith('or', lane.events)}); received none`;
  }
  const failures: string[] = [];
  for (const run of runs) {
    try {
      requireJobs(
        api,
        repository,
        requirePositiveSafeInteger(run.id, 'candidate run ID'),
        requirePositiveSafeInteger(run.run_attempt, 'candidate run attempt'),
        lane.jobs
      );
      return undefined;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  const quantifier = lane.jobs.length === 1 ? '' : lane.jobs.length === 2 ? 'both ' : 'all ';
  return `no Actions evidence: ${listWith('and', lane.jobs)} did not ${quantifier}succeed in a ${lane.workflow} run on main for ${candidate}; received ${failures.join('; ')}`;
}

/**
 * A path-filtered lane Canary may find skipped. A skip counts only when an
 * earlier (or later) main commit ran the lane successfully and no
 * lane-relevant path differs between that commit and the source.
 */
interface SkippableLane {
  readonly receiptKey: 'cargo' | 'protocol';
  readonly workflow: string;
  readonly evidence: EvidenceLane;
  readonly rule: CoverageRule;
}

// Cargo Shim runs every lane on a push, so its Gate alone shows the workspace ran.
const CARGO_SHIM_LANE: SkippableLane = {
  receiptKey: 'cargo',
  workflow: 'cargo-shim.yml',
  evidence: { workflow: 'cargo-shim.yml', jobs: ['Cargo Shim Gate'], events: ['push'] },
  rule: {
    // The workflow's push path filter is generated from this same predicate.
    relevant: (paths) => classifyChangedPaths(paths).qualification,
    subject: 'Cargo Shim',
    verb: 'validated',
    noCandidates: 'no main commit has a successful Cargo Shim push run',
    headCovered: (head) => `${head} has a successful Cargo Shim push run`,
  },
};

// Protocol Gate goes green over a skipped compiled matrix when a push touches only
// prose guides, so the three matrix-free jobs must have run too.
const PROTOCOL_CI_LANE: SkippableLane = {
  receiptKey: 'protocol',
  workflow: 'protocol-ci.yml',
  evidence: {
    workflow: 'protocol-ci.yml',
    jobs: ['Protocol Gate', 'TypeScript', 'cargo-deny', 'Schema equality and round trip'],
    events: ['push'],
  },
  rule: {
    relevant: touchesProtocolSurface,
    subject: 'Protocol CI',
    verb: 'validated',
    noCandidates: 'no main commit has a successful Protocol CI push run',
    headCovered: (head) => `${head} has a successful Protocol CI push run`,
  },
};

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
  const predicate = requireJsonRecord(
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
  const coverage = rustCoverageFromGitHub(api, source.repository, source.sourceSha, (candidate) =>
    missingLaneJobEvidence(api, source.repository, candidate, CODEQL_RUST_EVIDENCE)
  );
  if (!coverage.covered) {
    throw new Error(
      `codeql.yml run ${runId}: Rust analyses were skipped for ${source.sourceSha} but no earlier or later main analysis covers it; expected a commit with ${CODEQL_RUST_JOBS.join(' and ')} analyses and no CodeQL-Rust-relevant path difference; received ${coverage.reason}`
    );
  }
  return { jobs: [], codeqlRust: { analyzed: false, reason: coverage.reason } };
}

/**
 * Settle a path-filtered lane that has no run on the source. Accepted only when
 * main's records cover the source (canary-lane-coverage.ts); the run listing
 * nominates candidates and Actions job evidence proves each one. Everything
 * else, a failed lookup included, rejects the source.
 */
function settleSkippedLane(
  api: CanaryValidationApi,
  source: CanaryValidationSource,
  lane: SkippableLane,
  workflowId: number
): LaneCoverageReceipt {
  const coverage = workflowCoverageFromGitHub(api, {
    repository: source.repository,
    sourceSha: source.sourceSha,
    workflowId,
    rule: lane.rule,
    evidence: (candidate) =>
      missingLaneJobEvidence(api, source.repository, candidate, lane.evidence),
  });
  if (!coverage.covered) {
    throw new Error(
      `${lane.workflow}: expected a covering main push run for ${source.sourceSha}; received ${coverage.reason}. The push path filter skipped the lane for this SHA, which counts only when a main commit with a successful ${listWith('and', lane.evidence.jobs)} push run differs from it in no ${lane.rule.subject}-relevant path. To recover, re-run the cancelled or failed ${lane.workflow} run of the newest ${lane.rule.subject}-relevant commit on main, then run Canary again`
    );
  }
  return { ranOnSource: false, reason: coverage.reason };
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
    const content = requireJsonRecord(
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
  const comparison = requireJsonRecord(
    api.get(`repos/${source.repository}/compare/${source.pushBeforeSha}...${source.sourceSha}`),
    'push comparison'
  );
  // A history rewrite may preserve the entire tree while losing ancestry.
  // The compare endpoint lists merge-base changes in that case, so only exact
  // commit-bound root-tree identity can prove the push changed no inputs.
  if (comparison.status === 'diverged') {
    const trees = [source.pushBeforeSha, source.sourceSha].map((sha) => {
      const commit = requireJsonRecord(
        api.get(`repos/${source.repository}/git/commits/${sha}`),
        `push commit ${sha}`
      );
      const tree = requireJsonRecord(commit.tree, `push commit ${sha} tree`).sha;
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
    requireJsonRecord(comparison.base_commit, 'comparison base').sha !== source.pushBeforeSha ||
    requireJsonRecord(comparison.merge_base_commit, 'comparison merge base').sha !==
      source.pushBeforeSha ||
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
    const file = requireJsonRecord(entry, 'changed file');
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
  requirePositiveSafeInteger(source.runId, 'selected run ID');
  requirePositiveSafeInteger(source.runAttempt, 'selected run attempt');
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
    const content = requireJsonRecord(
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
  const ciWorkflow = requireJsonRecord(
    api.get(`repos/${source.repository}/actions/workflows/ci.yml`),
    'CI workflow'
  );
  const ciWorkflowId = requirePositiveSafeInteger(ciWorkflow.id, 'CI workflow ID');
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
  const laneCoverage: Partial<Record<SkippableLane['receiptKey'], LaneCoverageReceipt>> = {};
  const policies: {
    workflow: string;
    required: boolean;
    jobs: readonly string[];
    /** Set for lanes whose push path filter may skip them. */
    lane?: SkippableLane;
  }[] = [
    {
      workflow: 'cargo-shim.yml',
      required: required.cargo,
      jobs: ['Cargo Shim Gate'],
      lane: CARGO_SHIM_LANE,
    },
    {
      workflow: 'protocol-ci.yml',
      required: required.protocol,
      jobs: ['Protocol Gate'],
      lane: PROTOCOL_CI_LANE,
    },
    {
      workflow: 'codeql.yml',
      required: true,
      // The Rust legs are settled separately: analyzed here or covered by an
      // earlier analysis (settleCodeqlRust).
      jobs: ['Analyze (javascript-typescript)'],
    },
  ];
  for (const policy of policies) {
    const workflow = requireJsonRecord(
      api.get(`repos/${source.repository}/actions/workflows/${policy.workflow}`),
      policy.workflow
    );
    const workflowId = requirePositiveSafeInteger(workflow.id, `${policy.workflow} ID`);
    const runs = api
      .list(
        `repos/${source.repository}/actions/workflows/${workflowId}/runs?branch=main&event=push&head_sha=${source.sourceSha}&per_page=100`,
        'workflow_runs'
      )
      .map((run) => requireJsonRecord(run, policy.workflow))
      .sort(
        (left, right) =>
          requirePositiveSafeInteger(right.run_number, 'sibling run number') -
          requirePositiveSafeInteger(left.run_number, 'sibling run number')
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
      // The push path filter judged only this push's range. A skipped lane
      // counts when a main commit that ran it differs from the source in no
      // relevant path; otherwise an earlier relevant commit whose own run was
      // cancelled or failed would reach Canary without any main run of the lane.
      if (policy.lane) {
        laneCoverage[policy.lane.receiptKey] = settleSkippedLane(
          api,
          source,
          policy.lane,
          workflowId
        );
      }
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
    const runId = requirePositiveSafeInteger(run.id, `${policy.workflow} run ID`);
    const attempt = requirePositiveSafeInteger(run.run_attempt, `${policy.workflow} attempt`);
    const jobs = requireJobs(api, source.repository, runId, attempt, policy.jobs);
    if (policy.lane) {
      laneCoverage[policy.lane.receiptKey] = {
        ranOnSource: true,
        reason: `${policy.lane.rule.subject} ran on ${source.sourceSha}`,
      };
    }
    if (policy.workflow === 'codeql.yml') {
      const rust = settleCodeqlRust(api, source, runId, attempt);
      jobs.push(...rust.jobs);
      codeqlRust = rust.codeqlRust;
    }
    siblings.push({ workflow: policy.workflow, runId, attempt, result: 'success', jobs });
  }
  const { cargo, protocol } = laneCoverage;
  if (!cargo || !protocol) {
    throw new Error(
      `Cargo Shim and Protocol CI coverage: expected both lanes settled; received ${JSON.stringify(laneCoverage)}`
    );
  }
  return {
    source,
    builderAttempt,
    ciJobs,
    siblings,
    relevance: required,
    codeqlRust,
    laneCoverage: { cargo, protocol },
  };
}
