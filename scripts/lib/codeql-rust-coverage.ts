// Decides whether an earlier CodeQL Rust analysis on main still covers a commit.
// codeql.yml uses it to skip the Rust legs on a push, and the Canary qualifier
// uses the same rule to accept a SHA whose Rust legs were skipped. Canary also
// reuses the procedure for Cargo Shim and Protocol CI through a CoverageRule.
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
import { isJsonRecord } from './script-guards';

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

/**
 * API path of one page of main's CodeQL analyses, newest first.
 * @example
 * codeScanningAnalysesPath('owner/repo', 1);
 */
export function codeScanningAnalysesPath(repository: string, page: number): string {
  return `repos/${repository}/code-scanning/analyses?ref=refs/heads/main&tool_name=CodeQL&per_page=${ANALYSES_PAGE_SIZE}&page=${page}`;
}

interface ValidRustAnalysis {
  readonly sha: string;
  readonly category: string;
  readonly time: number;
}

/**
 * The entries that count as a Rust analysis on main. One that is malformed, has
 * an upload error, comes from another tool or workflow job, or targets another
 * ref is ignored: ignoring only removes evidence, so it never widens coverage.
 */
function validRustAnalyses(analyses: readonly unknown[]): ValidRustAnalysis[] {
  const valid: ValidRustAnalysis[] = [];
  for (const entry of analyses) {
    if (!isJsonRecord(entry) || !isJsonRecord(entry.tool)) continue;
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
    valid.push({ sha, category, time: Date.parse(createdAt) });
  }
  return valid;
}

/**
 * Commits on main with a complete analysis in every Rust category, newest first.
 * @example
 * rustAnalyzedCommits(page); // ['<newest sha>', '<older sha>']
 */
export function rustAnalyzedCommits(analyses: readonly unknown[]): string[] {
  const seen = new Map<string, { categories: Set<string>; newest: number }>();
  for (const { sha, category, time } of validRustAnalyses(analyses)) {
    const commit = seen.get(sha) ?? { categories: new Set<string>(), newest: 0 };
    commit.categories.add(category);
    commit.newest = Math.max(commit.newest, time);
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
 * The commit that code scanning currently treats as main's Rust baseline: the
 * newest analysis of each Rust category must sit on one commit. Undefined when
 * a category has no analysis, the newest analyses disagree, or two analyses of
 * a category tie for newest on different commits.
 * @example
 * currentRustAnalysisCommit(page); // '<sha>'
 */
export function currentRustAnalysisCommit(analyses: readonly unknown[]): string | undefined {
  const valid = validRustAnalyses(analyses);
  const heads = CODEQL_RUST_CATEGORIES.map((category) => {
    const inCategory = valid.filter((analysis) => analysis.category === category);
    const newest = Math.max(...inCategory.map((analysis) => analysis.time));
    return new Set(
      inCategory.filter((analysis) => analysis.time === newest).map((analysis) => analysis.sha)
    );
  });
  // Each category needs exactly one newest commit, and the categories must agree.
  const agreed = new Set(heads.flatMap((shas) => [...shas]));
  return heads.every((shas) => shas.size === 1) && agreed.size === 1 ? [...agreed][0] : undefined;
}

/**
 * Read main's analyses newest first until enough covering candidates are known
 * or the bounded lookback ends. A failed or malformed page throws, so callers
 * choose their fail-safe direction.
 * @example
 * const analyses = readRustAnalyses('owner/repo', (path) => gh(path));
 */
function readRustAnalyses(repository: string, fetchPage: FetchAnalysesPage): unknown[] {
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
  return analyses;
}

/**
 * Candidate commits for a coverage decision, newest first.
 * @example
 * const commits = readRustAnalyzedCommits('owner/repo', (path) => gh(path));
 */
export function readRustAnalyzedCommits(
  repository: string,
  fetchPage: FetchAnalysesPage
): string[] {
  return rustAnalyzedCommits(readRustAnalyses(repository, fetchPage));
}

/** Whether the CodeQL Rust legs must run for a push, with the evidence behind the choice. */
export interface RustLegDecision {
  readonly rust: boolean;
  readonly reason: string;
}

/**
 * Decide the Rust legs of a push to main: skip only when the commit that code
 * scanning currently holds as main's Rust baseline covers the head. Stricter
 * than Canary's rule on purpose: a revert of an analyzed Rust change matches an
 * older analysis, but skipping would leave the Security tab and pull request
 * comparisons on the newer analysis, so the revert is analyzed instead. Any
 * failure while reading or diffing analyzes, so an API outage costs minutes and
 * never coverage.
 * @example
 * decideRustLegsForPush({ head, repository, fetchPage, pathsBetween }); // { rust: false, reason }
 */
export function decideRustLegsForPush(input: {
  readonly head: string;
  readonly repository: string;
  readonly fetchPage: FetchAnalysesPage;
  readonly pathsBetween: PathsBetween;
}): RustLegDecision {
  try {
    const baseline = currentRustAnalysisCommit(readRustAnalyses(input.repository, input.fetchPage));
    if (baseline === undefined) {
      return {
        rust: true,
        reason:
          'the newest analyses of the two Rust categories do not sit on one commit, or one is missing',
      };
    }
    // Trust boundary: this decision reads code scanning rows without checking
    // Actions evidence. Rows are uploader-controlled (ref, commit and category
    // are parameters of a SARIF upload), so a forged baseline could make this
    // push skip Rust. That only costs alert freshness until the weekly run,
    // and Canary never relies on it: it re-proves coverage from Actions job
    // records before accepting a skipped SHA (canary-validation.ts).
    const coverage = resolveRustCoverage(input.head, [baseline], input.pathsBetween);
    return { rust: !coverage.covered, reason: coverage.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { rust: true, reason: `coverage lookup failed, analyzing Rust: ${message}` };
  }
}

/**
 * Independent proof that a candidate's Rust legs really ran: undefined when the
 * proof holds, otherwise the missing evidence. Code scanning rows alone cannot
 * be this proof, because an uploader chooses their ref, commit and category.
 */
export type CandidateEvidence = (candidate: string) => string | undefined;

/**
 * What a lane counts as a change worth rerunning, and how its coverage reasons
 * read. The decision procedure is shared; each lane brings its own predicate.
 * Canary uses the same rule for Cargo Shim and Protocol CI (canary-validation.ts).
 */
export interface CoverageRule {
  /** Whether a non-empty list of changed paths can change the lane's verdict. */
  readonly relevant: (paths: readonly string[]) => boolean;
  /** Names the lane in "<subject>-relevant change". */
  readonly subject: string;
  /** Past participle of what a candidate did: "analyzed" or "validated". */
  readonly verb: string;
  /** Reason given when the candidate list is empty. */
  readonly noCandidates: string;
  /** Reason given when the head is itself a candidate. */
  readonly headCovered: (head: string) => string;
}

/** The CodeQL Rust legs' rule: `codeql.yml` and Canary both decide with it. */
export const CODEQL_RUST_RULE: CoverageRule = {
  relevant: codeqlRustRelevant,
  subject: 'Rust',
  verb: 'analyzed',
  noCandidates: 'no main commit has an error-free analysis in both Rust categories',
  headCovered: (head) => `${head} has both Rust analyses`,
};

/**
 * Apply the coverage rule to `head` against newest-first candidate commits.
 * With `evidence`, a candidate that passes the path check still counts only if
 * the evidence holds for it; the rows that nominated it are never the proof.
 * @example
 * resolveRustCoverage(headSha, candidates, pathsBetween); // { covered: true, base, reason }
 */
export function resolveRustCoverage(
  head: string,
  candidates: readonly string[],
  pathsBetween: PathsBetween,
  evidence?: CandidateEvidence,
  rule: CoverageRule = CODEQL_RUST_RULE
): RustCoverage {
  if (candidates.length === 0) {
    return { covered: false, reason: rule.noCandidates };
  }
  const tried: string[] = [];
  for (const base of candidates.slice(0, CODEQL_RUST_MAX_CANDIDATES)) {
    const paths = base === head ? [] : pathsBetween(base, head);
    if (paths === undefined) {
      tried.push(`${base} (difference unproven)`);
      continue;
    }
    if (paths.length > 0 && rule.relevant(paths)) {
      tried.push(`${base} (${rule.subject}-relevant change)`);
      continue;
    }
    // The path check passed; the candidate still needs independent proof.
    const missing = evidence?.(base);
    if (missing !== undefined) {
      tried.push(`${base} (${missing})`);
      continue;
    }
    return {
      covered: true,
      base,
      reason:
        base === head
          ? rule.headCovered(head)
          : `no ${rule.subject}-relevant path differs between ${rule.verb} ${base} and ${head}`,
    };
  }
  return { covered: false, reason: `no candidate covers ${head}: ${tried.join(', ')}` };
}
