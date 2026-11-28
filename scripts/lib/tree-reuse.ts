// Shadow proof that a main push commit's tree was already tested by the merged
// pull request's last CI run (docs/reference/ci.md, "Tree reuse shadow").
//
// A squash merge of a PR whose tested merge commit had the pushed base as its
// first parent produces a commit with the same tree as that test merge. When
// that holds and nothing that could change CI itself moved, the pull request's
// green run says what a main run would say. This module only COMPUTES that
// claim; nothing consumes it yet, and every doubt answers `reuse: false`.
//
// The proof comes from git objects and the Actions API, never from anything the
// pull request run wrote. Reads go through the synchronous `get`/`list` port
// Canary's validation already uses (scripts/lib/canary-gh-api.ts). The resolver
// never throws: a failed read or a payload of the wrong shape is a reason.
//
// Dependency-free (Node built-ins and ./script-guards): the Preflight job runs
// it straight from a checkout, with `bun install` not run.

import { describeReceived, invalidValue, requireJsonRecord } from './script-guards';

/** The GitHub read port; `createCanaryGhApi()` and the test fake both satisfy it. */
export interface TreeReuseApi {
  get(path: string): unknown;
  list(path: string, key: string): readonly unknown[];
}

export interface TreeReuseInput {
  readonly repository: string;
  /** The pushed commit (`github.sha`). */
  readonly sha: string;
  /** The tip of main before the push (`github.event.before`). */
  readonly before: string;
}

export type TreeReuseVerdict =
  | {
      readonly reuse: true;
      /** The pull request CI run whose verdict the push may reuse. */
      readonly runId: number;
      /** The merge commit that run tested. */
      readonly mergeCommit: string;
      /** The tree both that merge commit and the pushed commit hold. */
      readonly tree: string;
    }
  | { readonly reuse: false; readonly reason: string };

/** Injected so a test never reads the clock or the job list of a real workflow. */
export interface TreeReuseDeps {
  readonly now: () => number;
  /**
   * Jobs (by their run-API name) a later stage may skip, besides `CI Gate`.
   * Each must have succeeded in the proven run.
   */
  readonly skippableJobs: readonly string[];
}

/** The Browser Smoke jobs, as the jobs API names them in a pull request run (reusable-workflow caller name, then job name). */
export const TREE_REUSE_SKIPPABLE_JOBS: readonly string[] = [
  'Smoke — Browser / Chromium smoke suite',
  'Smoke — Browser / Production frontend regressions',
];

const TREE_REUSE_GATE_JOB = 'CI Gate';

/** How stale a pull request run may be, measured from its last update to now. */
const TREE_REUSE_MAX_RUN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The compare API lists at most 300 files; a response that reaches it may be
 * cut, so it cannot prove an untouched path.
 */
export const COMPARE_FILE_LIMIT = 300;

/** Paths whose change can alter what CI is or how it decides; a push touching one runs in full. */
const TREE_REUSE_FORBIDDEN_PREFIXES: readonly string[] = ['.github/', 'scripts/ci/'];
const TREE_REUSE_FORBIDDEN_FILES: readonly string[] = ['scripts/lib/tree-reuse.ts'];

const CI_WORKFLOW_FILE = 'ci.yml';
const CI_WORKFLOW_PATH = `.github/workflows/${CI_WORKFLOW_FILE}`;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
// A run stamped a little in the future is clock skew; a long way ahead is not a finish time.
const FUTURE_SKEW_MS = 5 * 60 * 1000;

const DEFAULT_DEPS: TreeReuseDeps = {
  now: () => Date.now(),
  skippableJobs: TREE_REUSE_SKIPPABLE_JOBS,
};

function requireSha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw invalidValue(label, '40-character lowercase hex commit SHA', value);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '')
    throw invalidValue(label, 'non-empty string', value);
  return value;
}

function requireCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalidValue(label, 'positive safe integer', value);
  }
  return value;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalidValue(label, 'array', value);
  return value;
}

/** `commit.parents[].sha` and `commit.commit.tree.sha` of a `commits/{sha}` payload. */
function readCommit(
  api: TreeReuseApi,
  repository: string,
  sha: string
): { readonly parents: readonly string[]; readonly tree: string } {
  const commit = requireJsonRecord(api.get(`repos/${repository}/commits/${sha}`), `commit ${sha}`);
  const parents = requireArray(commit.parents, `commit ${sha} parents`).map((parent, index) =>
    requireSha(
      requireJsonRecord(parent, `commit ${sha} parent ${index}`).sha,
      `commit ${sha} parent ${index} sha`
    )
  );
  const inner = requireJsonRecord(commit.commit, `commit ${sha} commit`);
  const tree = requireSha(
    requireJsonRecord(inner.tree, `commit ${sha} tree`).sha,
    `commit ${sha} tree sha`
  );
  return { parents, tree };
}

/** Check 1: the push commit has exactly one parent and it is `before`. Returns its tree. */
function checkSinglePushParent(api: TreeReuseApi, input: TreeReuseInput): string {
  const { parents, tree } = readCommit(api, input.repository, input.sha);
  if (parents.length !== 1 || parents[0] !== input.before) {
    throw invalidValue(
      `push commit ${input.sha} parents`,
      `exactly one parent equal to before ${input.before}`,
      parents
    );
  }
  return tree;
}

interface MergedPullRequest {
  readonly number: number;
  readonly headSha: string;
}

/** Check 2: exactly one merged, same-repository, non-bot pull request into main produced `sha`. */
function checkMergedPullRequest(api: TreeReuseApi, input: TreeReuseInput): MergedPullRequest {
  const pulls = requireArray(
    api.get(`repos/${input.repository}/commits/${input.sha}/pulls`),
    `pull requests of ${input.sha}`
  );
  if (pulls.length !== 1) {
    throw invalidValue(
      `pull request count of ${input.sha}`,
      'exactly one pull request',
      pulls.length
    );
  }
  const pull = requireJsonRecord(pulls[0], 'pull request');
  const number = requireCount(pull.number, 'pull request number');
  const label = `pull request #${number}`;
  if (typeof pull.merged_at !== 'string' || pull.merged_at === '') {
    throw invalidValue(
      `${label} merged_at`,
      'a merge timestamp (a merged pull request)',
      pull.merged_at
    );
  }
  if (pull.merge_commit_sha !== input.sha) {
    throw invalidValue(
      `${label} merge_commit_sha`,
      `the push commit ${input.sha}`,
      pull.merge_commit_sha
    );
  }
  const base = requireJsonRecord(pull.base, `${label} base`);
  if (base.ref !== 'main') throw invalidValue(`${label} base ref`, 'main', base.ref);
  const head = requireJsonRecord(pull.head, `${label} head`);
  const headRepository =
    head.repo === null ? null : requireJsonRecord(head.repo, `${label} head repo`);
  if (headRepository?.full_name !== input.repository) {
    throw invalidValue(
      `${label} head repository`,
      `this repository ${input.repository} (not a fork)`,
      headRepository?.full_name ?? null
    );
  }
  const author = requireJsonRecord(pull.user, `${label} author`);
  const login = requireString(author.login, `${label} author login`);
  const type = requireString(author.type, `${label} author type`);
  if (type === 'Bot' || login.endsWith('[bot]')) {
    throw invalidValue(`${label} author`, 'a non-bot account', `${login} (${type})`);
  }
  return { number, headSha: requireSha(head.sha, `${label} head sha`) };
}

interface ProvenRun {
  readonly id: number;
  readonly referencedWorkflows: unknown;
}

/** Check 3: the newest `ci.yml` pull request run on the PR head is a fresh, first-attempt success. */
function checkPullRequestRun(
  api: TreeReuseApi,
  input: TreeReuseInput,
  pull: MergedPullRequest,
  now: number
): ProvenRun {
  const runs = api
    .list(
      `repos/${input.repository}/actions/workflows/${CI_WORKFLOW_FILE}/runs?event=pull_request&head_sha=${pull.headSha}&per_page=100`,
      'workflow_runs'
    )
    .map((run, index) => requireJsonRecord(run, `ci.yml run ${index}`))
    // The query filters already; repeating them keeps an ignored parameter from choosing the run.
    .filter((run) => run.event === 'pull_request' && run.head_sha === pull.headSha);
  if (runs.length === 0) {
    throw invalidValue(
      `ci.yml pull_request runs for head ${pull.headSha}`,
      'at least one run',
      'none'
    );
  }
  // A re-run keeps its run number and raises run_attempt, so the number orders distinct runs.
  const newest = runs.reduce((best, run) =>
    requireCount(run.run_number, 'run number') > requireCount(best.run_number, 'run number')
      ? run
      : best
  );
  const id = requireCount(newest.id, 'run id');
  const label = `newest ci.yml pull_request run ${id}`;
  if (newest.status !== 'completed' || newest.conclusion !== 'success') {
    throw invalidValue(`${label} status and conclusion`, 'completed and success', {
      status: newest.status,
      conclusion: newest.conclusion,
    });
  }
  if (newest.run_attempt !== 1) {
    throw invalidValue(
      `${label} run_attempt`,
      '1 (a re-run may have mixed attempts)',
      newest.run_attempt
    );
  }
  if (newest.path !== CI_WORKFLOW_PATH) {
    throw invalidValue(`${label} workflow path`, CI_WORKFLOW_PATH, newest.path);
  }
  for (const field of ['repository', 'head_repository'] as const) {
    const name = requireJsonRecord(newest[field], `${label} ${field}`).full_name;
    if (name !== input.repository) {
      throw invalidValue(`${label} ${field}`, input.repository, name);
    }
  }
  const finishedText = requireString(newest.updated_at, `${label} updated_at`);
  const finished = Date.parse(finishedText);
  if (Number.isNaN(finished))
    throw invalidValue(`${label} updated_at`, 'an ISO timestamp', finishedText);
  const age = now - finished;
  if (age > TREE_REUSE_MAX_RUN_AGE_MS || age < -FUTURE_SKEW_MS) {
    throw invalidValue(
      `${label} updated_at ${finishedText}`,
      'finished within the last 24 hours',
      `${Math.round(age / 60_000)} minutes ago`
    );
  }
  return { id, referencedWorkflows: newest.referenced_workflows };
}

/**
 * Check 4: every called workflow of the run resolved to one merge commit M, on the PR's merge ref.
 *
 * Observed on run 46108381115 (pull request #2742, merged as aab5bd6c; read 2026-11-28 from
 * `repos/{repo}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=<PR head>`). The field
 * lists the called reusable workflows, 14 of them, never `ci.yml` itself; each entry carries the
 * commit it was resolved at, which for `pull_request` is the merge commit the run checked out:
 *
 *   "referenced_workflows": [
 *     {
 *       "path": "juliopolycarpo/mangostudio/.github/workflows/test.yml@2d76660576403d1c93bb5cc1b32e69704512a105",
 *       "ref": "refs/pull/2742/merge",
 *       "sha": "2d76660576403d1c93bb5cc1b32e69704512a105"
 *     },
 *     ...
 *   ]
 *
 * That commit has parents [7f5d9555 (main then), 1fb221eb (PR head)] and tree b3e771d4, the tree
 * of the squash commit aab5bd6c. The same run reports `"pull_requests": []`, so the pull request
 * is never read from the run.
 */
function checkReferencedWorkflows(run: ProvenRun, pull: MergedPullRequest): string {
  const entries = requireArray(run.referencedWorkflows, `run ${run.id} referenced_workflows`);
  if (entries.length === 0) {
    throw invalidValue(`run ${run.id} referenced_workflows`, 'a non-empty array', entries);
  }
  const expectedRef = `refs/pull/${pull.number}/merge`;
  const shas = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const record = requireJsonRecord(entry, `run ${run.id} referenced workflow ${index}`);
    if (record.ref !== expectedRef) {
      throw invalidValue(`run ${run.id} referenced workflow ${index} ref`, expectedRef, record.ref);
    }
    shas.add(requireSha(record.sha, `run ${run.id} referenced workflow ${index} sha`));
  }
  if (shas.size !== 1) {
    throw invalidValue(`run ${run.id} referenced workflow shas`, 'one and the same commit', [
      ...shas,
    ]);
  }
  return [...shas][0] as string;
}

/** Check 5: M merges the PR head into `before`, and holds the pushed commit's tree. */
function checkMergeCommit(
  api: TreeReuseApi,
  input: TreeReuseInput,
  pull: MergedPullRequest,
  mergeCommit: string,
  pushTree: string
): void {
  const { parents, tree } = readCommit(api, input.repository, mergeCommit);
  const expected = [input.before, pull.headSha];
  if (parents.length !== 2 || parents[0] !== expected[0] || parents[1] !== expected[1]) {
    throw invalidValue(
      `merge commit ${mergeCommit} parents`,
      `[before ${expected[0]}, pull request head ${expected[1]}]`,
      parents
    );
  }
  if (tree !== pushTree) {
    throw invalidValue(`merge commit ${mergeCommit} tree`, `push commit tree ${pushTree}`, tree);
  }
}

/** Check 6: `CI Gate` and each skippable job succeeded on their latest attempt of the run. */
function checkJobsSucceeded(
  api: TreeReuseApi,
  input: TreeReuseInput,
  runId: number,
  skippableJobs: readonly string[]
): void {
  const jobs = api
    .list(`repos/${input.repository}/actions/runs/${runId}/jobs?filter=all&per_page=100`, 'jobs')
    .map((job, index) => requireJsonRecord(job, `run ${runId} job ${index}`));
  for (const name of [TREE_REUSE_GATE_JOB, ...skippableJobs]) {
    const attempts = jobs
      .filter((job) => job.name === name)
      .map((job) => ({ job, attempt: requireCount(job.run_attempt, `job "${name}" run_attempt`) }))
      .sort((left, right) => right.attempt - left.attempt);
    const latest = attempts[0];
    if (latest === undefined) {
      throw invalidValue(`run ${runId} job "${name}"`, 'a job with that name', 'no such job');
    }
    if (attempts[1]?.attempt === latest.attempt) {
      throw invalidValue(
        `run ${runId} job "${name}"`,
        'one job per attempt',
        'two at the latest attempt'
      );
    }
    const { job } = latest;
    if (job.status !== 'completed' || job.conclusion !== 'success' || job.run_id !== runId) {
      throw invalidValue(
        `run ${runId} job "${name}" (attempt ${latest.attempt}) status, conclusion and run_id`,
        `completed, success and ${runId}`,
        { status: job.status, conclusion: job.conclusion, run_id: job.run_id }
      );
    }
  }
}

/**
 * Check 7: the pushed commit touches nothing that could change CI itself.
 *
 * The diff comes from the compare API rather than local git: it uses the same
 * port as every other read (so one fake serves the whole resolver), needs no
 * checkout depth, and its one weakness, a response cut at 300 files, is
 * explicit and refused. Renames list both sides, so moving a file out of a
 * guarded path is caught by `previous_filename`.
 */
function checkDiffScope(api: TreeReuseApi, input: TreeReuseInput): void {
  const compare = requireJsonRecord(
    api.get(`repos/${input.repository}/compare/${input.before}...${input.sha}`),
    'compare response'
  );
  if (compare.total_commits !== 1) {
    throw invalidValue(
      'compare total_commits',
      'exactly the one push commit (1)',
      compare.total_commits
    );
  }
  const files = requireArray(compare.files, 'compare files');
  if (files.length >= COMPARE_FILE_LIMIT) {
    throw invalidValue(
      'compare files',
      `fewer than ${COMPARE_FILE_LIMIT} entries (the API truncates there)`,
      `${files.length} entries`
    );
  }
  for (const [index, file] of files.entries()) {
    const record = requireJsonRecord(file, `compare file ${index}`);
    const paths = [requireString(record.filename, `compare file ${index} filename`)];
    if (record.previous_filename !== undefined) {
      paths.push(
        requireString(record.previous_filename, `compare file ${index} previous_filename`)
      );
    }
    for (const path of paths) {
      const guarded =
        TREE_REUSE_FORBIDDEN_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
        TREE_REUSE_FORBIDDEN_FILES.includes(path);
      if (guarded) {
        throw invalidValue(
          'changed path',
          `none under ${TREE_REUSE_FORBIDDEN_PREFIXES.join(', ')} or ${TREE_REUSE_FORBIDDEN_FILES.join(', ')}`,
          path
        );
      }
    }
  }
}

/**
 * Decide whether the push commit's tree was already tested by its pull request's last run.
 * Never throws; any failed read or malformed payload is `reuse: false` with the reason.
 * @example resolveTreeReuse(createCanaryGhApi(), { repository, sha, before })
 */
export function resolveTreeReuse(
  api: TreeReuseApi,
  input: TreeReuseInput,
  deps: TreeReuseDeps = DEFAULT_DEPS
): TreeReuseVerdict {
  let stage = 'input';
  try {
    requireString(input.repository, 'repository');
    requireSha(input.sha, 'push sha');
    requireSha(input.before, 'before sha');

    stage = 'single-parent push commit';
    const pushTree = checkSinglePushParent(api, input);
    // Cheap and the likeliest refusal while CI itself changes often, so it goes before the run reads.
    stage = 'diff scope';
    checkDiffScope(api, input);
    stage = 'merged pull request';
    const pull = checkMergedPullRequest(api, input);
    stage = 'pull request run';
    const run = checkPullRequestRun(api, input, pull, deps.now());
    stage = 'referenced workflows';
    const mergeCommit = checkReferencedWorkflows(run, pull);
    stage = 'merge commit';
    checkMergeCommit(api, input, pull, mergeCommit, pushTree);
    stage = 'jobs';
    checkJobsSucceeded(api, input, run.id, deps.skippableJobs);
    return { reuse: true, runId: run.id, mergeCommit, tree: pushTree };
  } catch (error) {
    const message = error instanceof Error ? error.message : describeReceived(error);
    return { reuse: false, reason: `${stage}: ${message}` };
  }
}
