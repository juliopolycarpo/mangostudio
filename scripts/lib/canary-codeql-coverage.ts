// Canary's proof that a SHA whose CodeQL Rust legs were skipped is still
// covered. It recomputes the rule from GitHub's own records instead of
// trusting the codeql.yml run that skipped the legs.
import {
  type CandidateEvidence,
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
 * Path-difference provider over the compare API. The analyzed commit may sit
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
  return resolveRustCoverage(sourceSha, candidates, comparePathsBetween(api, repository), evidence);
}
