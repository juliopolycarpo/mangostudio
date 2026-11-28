// Decides whether an earlier CodeQL Rust analysis on main still covers a commit.
// codeql.yml uses it to skip the Rust legs on a push, and the Canary qualifier
// uses the same rule to accept a SHA whose Rust legs were skipped.
//
// The rule works on trees, not on the push's parent. Main runs are cancelled
// when superseded, so a parent can have no Rust analysis even though it holds
// a Rust change. A commit is covered only when some commit with a complete,
// error-free analysis in both Rust categories differs from it in no path that
// CODEQL_RUST_PATTERN matches. Every doubt (no candidate, unreadable history,
// malformed API data) means "not covered": the workflow then analyzes, and
// Canary rejects the SHA.
//
// Dependency-free: codeql.yml runs it before `bun install`.
import { codeqlRustRelevant } from './ci-lanes';

/** Analysis key code scanning records for the `analyze-rust` job of codeql.yml. */
export const CODEQL_RUST_ANALYSIS_KEY = '.github/workflows/codeql.yml:analyze-rust';
/** Categories of the Linux and Windows Rust legs; a covering commit needs both. */
export const CODEQL_RUST_CATEGORIES: readonly string[] = [
  '/language:rust',
  '/language:rust/windows',
];
/** Newest covering candidates tried per decision; each one is checked on its own. */
export const CODEQL_RUST_MAX_CANDIDATES = 5;
const ANALYSES_PAGE_SIZE = 100;
const ANALYSES_MAX_PAGES = 5;

/** Outcome of the coverage rule; `reason` names the commit or the missing evidence. */
export type RustCoverage =
  | { readonly covered: true; readonly base: string; readonly reason: string }
  | { readonly covered: false; readonly reason: string };

/**
 * Paths whose change separates two commits, an empty list for identical trees,
 * or undefined when the difference cannot be proven (history missing, diff
 * truncated, commits not on one line).
 */
export type PathsBetween = (base: string, head: string) => readonly string[] | undefined;

/** Reads one page of an analyses listing by API path; throws on a failed request. */
export type FetchAnalysesPage = (path: string) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * API path of one page of main's CodeQL analyses, newest first.
 * @example
 * codeScanningAnalysesPath('owner/repo', 1);
 */
export function codeScanningAnalysesPath(repository: string, page: number): string {
  return `repos/${repository}/code-scanning/analyses?ref=refs/heads/main&tool_name=CodeQL&per_page=${ANALYSES_PAGE_SIZE}&page=${page}`;
}

/**
 * Commits on main with a complete analysis in every Rust category, newest first.
 * An entry that is malformed, has an upload error, comes from another tool or
 * workflow job, or targets another ref is ignored: ignoring only removes a
 * candidate, so it can never widen coverage.
 * @example
 * rustAnalyzedCommits(page); // ['<newest sha>', '<older sha>']
 */
export function rustAnalyzedCommits(analyses: readonly unknown[]): string[] {
  const seen = new Map<string, { categories: Set<string>; newest: number }>();
  for (const entry of analyses) {
    if (!isRecord(entry) || !isRecord(entry.tool)) continue;
    const { commit_sha: sha, category, created_at: createdAt } = entry;
    if (
      entry.ref !== 'refs/heads/main' ||
      entry.analysis_key !== CODEQL_RUST_ANALYSIS_KEY ||
      entry.tool.name !== 'CodeQL' ||
      entry.error !== '' ||
      typeof sha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(sha) ||
      typeof category !== 'string' ||
      !CODEQL_RUST_CATEGORIES.includes(category) ||
      typeof createdAt !== 'string' ||
      Number.isNaN(Date.parse(createdAt))
    )
      continue;
    const commit = seen.get(sha) ?? { categories: new Set<string>(), newest: 0 };
    commit.categories.add(category);
    commit.newest = Math.max(commit.newest, Date.parse(createdAt));
    seen.set(sha, commit);
  }
  return [...seen.entries()]
    .filter(([, commit]) =>
      CODEQL_RUST_CATEGORIES.every((category) => commit.categories.has(category))
    )
    .sort((left, right) => right[1].newest - left[1].newest)
    .map(([sha]) => sha);
}

/**
 * Read main's analyses newest first until enough covering candidates are known
 * or the bounded lookback ends. A failed or malformed page throws, so callers
 * choose their fail-safe direction.
 * @example
 * const commits = readRustAnalyzedCommits('owner/repo', (path) => gh(path));
 */
export function readRustAnalyzedCommits(
  repository: string,
  fetchPage: FetchAnalysesPage
): string[] {
  const analyses: unknown[] = [];
  for (let page = 1; page <= ANALYSES_MAX_PAGES; page++) {
    const path = codeScanningAnalysesPath(repository, page);
    const body = fetchPage(path);
    if (!Array.isArray(body)) {
      throw new Error(
        `${path}: expected a JSON array of analyses; received ${JSON.stringify(body)?.slice(0, 200)}`
      );
    }
    analyses.push(...body);
    if (
      body.length < ANALYSES_PAGE_SIZE ||
      rustAnalyzedCommits(analyses).length >= CODEQL_RUST_MAX_CANDIDATES
    )
      break;
  }
  return rustAnalyzedCommits(analyses);
}

/**
 * Apply the coverage rule to `head` against newest-first candidate commits.
 * @example
 * resolveRustCoverage(headSha, candidates, pathsBetween); // { covered: true, base, reason }
 */
export function resolveRustCoverage(
  head: string,
  candidates: readonly string[],
  pathsBetween: PathsBetween
): RustCoverage {
  if (candidates.length === 0) {
    return {
      covered: false,
      reason: 'no main commit has an error-free analysis in both Rust categories',
    };
  }
  const tried: string[] = [];
  for (const base of candidates.slice(0, CODEQL_RUST_MAX_CANDIDATES)) {
    if (base === head) {
      return { covered: true, base, reason: `${head} has both Rust analyses` };
    }
    const paths = pathsBetween(base, head);
    if (paths === undefined) {
      tried.push(`${base} (difference unproven)`);
    } else if (paths.length > 0 && codeqlRustRelevant(paths)) {
      tried.push(`${base} (Rust-relevant change)`);
    } else {
      return {
        covered: true,
        base,
        reason: `no Rust-relevant path differs between analyzed ${base} and ${head}`,
      };
    }
  }
  return { covered: false, reason: `no candidate covers ${head}: ${tried.join(', ')}` };
}
