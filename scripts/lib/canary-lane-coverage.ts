// Canary's proof that a SHA a lane skipped is still covered by an earlier (or
// later) main commit that ran it. One decision procedure serves the CodeQL Rust
// legs, Cargo Shim and Protocol CI; they differ in who nominates candidates and
// in the relevance predicate (CoverageRule). Canary recomputes the rule from
// GitHub's own records instead of trusting the run that skipped the lane.
import {
  type CandidateEvidence,
  CODEQL_RUST_RULE,
  type CoverageRule,
  type PathsBetween,
  readRustAnalyzedCommits,
  resolveRustCoverage,
  type RustCoverage,
} from './codeql-rust-coverage';

/** Read boundary shared with qualifyCanarySource; throws on a failed request. */
export interface CanaryCoverageApi {
  get(path: string): unknown;
}

// GitHub's compare endpoint stops listing files at 300.
const COMPARE_FILE_LIMIT = 300;
/** Successful runs read per lane; resolveRustCoverage tries only the newest few distinct commits. */
const NOMINATION_PAGE_SIZE = 20;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Paths changed from `ancestor` to `descendant`, or undefined unless the
 * comparison is a complete, linear ancestor-to-descendant range.
 */
function pathsAlongHistory(
  api: CanaryCoverageApi,
  repository: string,
  ancestor: string,
  descendant: string
): readonly string[] | undefined {
  const comparison = record(api.get(`repos/${repository}/compare/${ancestor}...${descendant}`));
  if (!comparison) return undefined;
  // compare lists changes from the merge base, so only a merge base equal to
  // the ancestor makes the file list the exact ancestor-to-descendant diff.
  if (
    !['ahead', 'identical'].includes(String(comparison.status)) ||
    record(comparison.base_commit)?.sha !== ancestor ||
    record(comparison.merge_base_commit)?.sha !== ancestor ||
    (comparison.truncated !== undefined && comparison.truncated !== false) ||
    !Array.isArray(comparison.files) ||
    comparison.files.length >= COMPARE_FILE_LIMIT
  )
    return undefined;
  const paths: string[] = [];
  for (const entry of comparison.files) {
    const file = record(entry);
    if (
      !file ||
      typeof file.filename !== 'string' ||
      (file.status === 'renamed' && typeof file.previous_filename !== 'string')
    )
      return undefined;
    paths.push(file.filename);
    if (typeof file.previous_filename === 'string') paths.push(file.previous_filename);
  }
  return paths;
}

/**
 * Path-difference provider over the compare API. The covering commit may sit
 * before or after the source; the relevance of a change does not depend on the
 * direction, so both linear orders are tried.
 * @example
 * resolveRustCoverage(sha, commits, comparePathsBetween(api, 'owner/repo'));
 */
function comparePathsBetween(api: CanaryCoverageApi, repository: string): PathsBetween {
  return (base, head) =>
    pathsAlongHistory(api, repository, base, head) ??
    pathsAlongHistory(api, repository, head, base);
}

/**
 * Whether main's Rust analyses cover `sourceSha`. Code scanning rows only
 * nominate candidates: uploaders choose a row's ref, commit and category, so
 * each candidate must also pass `evidence`, the Actions job proof.
 * @example
 * const coverage = rustCoverageFromGitHub(api, 'owner/repo', sourceSha, evidence);
 */
export function rustCoverageFromGitHub(
  api: CanaryCoverageApi,
  repository: string,
  sourceSha: string,
  evidence: CandidateEvidence
): RustCoverage {
  const candidates = readRustAnalyzedCommits(repository, (path) => api.get(path));
  return resolveRustCoverage(
    sourceSha,
    candidates,
    comparePathsBetween(api, repository),
    evidence,
    CODEQL_RUST_RULE
  );
}

/**
 * Commits whose push run of a workflow on main the listing reports as
 * successful, newest run first. The listing only nominates: a row says nothing
 * about the run's jobs or workflow bytes, so every candidate still needs the
 * Actions evidence. One bounded page is read; a failed or malformed read throws.
 * @example
 * successfulPushCommits(api, 'owner/repo', 43); // ['<newest sha>', '<older sha>']
 */
function successfulPushCommits(
  api: CanaryCoverageApi,
  repository: string,
  workflowId: number
): string[] {
  const path = `repos/${repository}/actions/workflows/${workflowId}/runs?branch=main&event=push&status=success&per_page=${NOMINATION_PAGE_SIZE}`;
  const body = api.get(path);
  const rows = record(body)?.workflow_runs;
  if (!Array.isArray(rows)) {
    throw new Error(
      `${path}: expected a workflow_runs array; received ${JSON.stringify(body)?.slice(0, 200)}`
    );
  }
  const nominated: { sha: string; number: number }[] = [];
  for (const entry of rows) {
    const row = record(entry);
    if (!row) continue;
    // A row that is malformed or not a successful main push is dropped: dropping
    // only removes a nomination, so it never widens coverage.
    if (
      row.event !== 'push' ||
      row.head_branch !== 'main' ||
      row.conclusion !== 'success' ||
      typeof row.head_sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(row.head_sha) ||
      !Number.isSafeInteger(row.run_number)
    )
      continue;
    nominated.push({ sha: row.head_sha, number: row.run_number as number });
  }
  nominated.sort((left, right) => right.number - left.number);
  return [...new Set(nominated.map(({ sha }) => sha))];
}

/**
 * Whether a skipped path-filtered workflow is still covered for `sourceSha`:
 * some commit with a successful main push run of it, and the Actions `evidence`
 * for that commit, differs from the source in no path `rule.relevant` matches.
 * Used when the source has no run of its own because the push filter skipped it.
 * @example
 * const coverage = workflowCoverageFromGitHub(api, { repository, sourceSha, workflowId, rule, evidence });
 */
export function workflowCoverageFromGitHub(
  api: CanaryCoverageApi,
  input: {
    readonly repository: string;
    readonly sourceSha: string;
    readonly workflowId: number;
    readonly rule: CoverageRule;
    readonly evidence: CandidateEvidence;
  }
): RustCoverage {
  const candidates = successfulPushCommits(api, input.repository, input.workflowId);
  return resolveRustCoverage(
    input.sourceSha,
    candidates,
    comparePathsBetween(api, input.repository),
    input.evidence,
    input.rule
  );
}
