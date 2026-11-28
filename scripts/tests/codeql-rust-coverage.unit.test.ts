import { describe, expect, test } from 'bun:test';

import {
  CODEQL_RUST_ANALYSIS_KEY,
  CODEQL_RUST_CATEGORIES,
  CODEQL_RUST_MAX_CANDIDATES,
  codeScanningAnalysesPath,
  currentRustAnalysisCommit,
  decideRustLegsForPush,
  type PathsBetween,
  readRustAnalyzedCommits,
  resolveRustCoverage,
  rustAnalyzedCommits,
} from '../lib/codeql-rust-coverage';

const sha = (digit: string) => digit.repeat(40);
const HEAD = sha('f');

/** One analysis in the shape of GET /code-scanning/analyses, with per-field overrides. */
function analysis(commit: string, category: string, createdAt: string, overrides = {}) {
  return {
    ref: 'refs/heads/main',
    commit_sha: commit,
    analysis_key: CODEQL_RUST_ANALYSIS_KEY,
    category,
    error: '',
    created_at: createdAt,
    tool: { name: 'CodeQL' },
    ...overrides,
  };
}

/** Both Rust legs for one commit. */
function bothLegs(commit: string, createdAt: string, overrides = {}) {
  return CODEQL_RUST_CATEGORIES.map((category) => analysis(commit, category, createdAt, overrides));
}

/** Named fake for the repository diff: answers from a table keyed by base commit. */
class FakeTreeDiff {
  readonly asked: string[] = [];
  constructor(private readonly diffs: Record<string, readonly string[] | undefined>) {}
  readonly pathsBetween: PathsBetween = (base) => {
    this.asked.push(base);
    return this.diffs[base];
  };
}

describe('rustAnalyzedCommits', () => {
  test('lists commits with both Rust categories, newest first', () => {
    const analyses = [
      ...bothLegs(sha('1'), '2026-11-20T10:00:00Z'),
      ...bothLegs(sha('2'), '2026-11-22T10:00:00Z'),
    ];
    expect(rustAnalyzedCommits(analyses)).toEqual([sha('2'), sha('1')]);
  });

  test('a commit with only one Rust leg is not a candidate', () => {
    // The Windows leg was cancelled: only the Linux category exists for this commit.
    const analyses = [analysis(sha('1'), '/language:rust', '2026-11-20T10:00:00Z')];
    expect(rustAnalyzedCommits(analyses)).toEqual([]);
  });

  test.each([
    ['an upload error', { error: 'processing failed' }],
    ['another ref', { ref: 'refs/pull/9/merge' }],
    ['another workflow job', { analysis_key: '.github/workflows/codeql.yml:analyze' }],
    ['another tool', { tool: { name: 'Semgrep' } }],
    ['a short commit SHA', { commit_sha: 'abc123' }],
    ['an invalid timestamp', { created_at: 'yesterday' }],
  ])('ignores an analysis with %s', (_label, overrides) => {
    expect(rustAnalyzedCommits(bothLegs(sha('1'), '2026-11-20T10:00:00Z', overrides))).toEqual([]);
  });

  test('ignores a category outside the Rust pair', () => {
    const analyses = [
      analysis(sha('1'), '/language:rust', '2026-11-20T10:00:00Z'),
      analysis(sha('1'), '/language:javascript-typescript', '2026-11-20T10:00:00Z'),
    ];
    expect(rustAnalyzedCommits(analyses)).toEqual([]);
  });

  test('skips non-object entries instead of throwing', () => {
    expect(
      rustAnalyzedCommits([null, 'x', 4, [], ...bothLegs(sha('1'), '2026-11-20T10:00:00Z')])
    ).toEqual([sha('1')]);
  });
});

describe('readRustAnalyzedCommits', () => {
  test('stops after a short first page', () => {
    const requested: string[] = [];
    const commits = readRustAnalyzedCommits('owner/repo', (path) => {
      requested.push(path);
      return bothLegs(sha('1'), '2026-11-20T10:00:00Z');
    });
    expect(commits).toEqual([sha('1')]);
    expect(requested).toEqual([codeScanningAnalysesPath('owner/repo', 1)]);
  });

  test('pages on until enough candidates are known, within the lookback bound', () => {
    const requested: string[] = [];
    // Every page is full of JavaScript analyses, so no candidate appears and the bound ends the read.
    const fullPage = Array.from({ length: 100 }, (_, index) =>
      analysis(
        sha('1'),
        '/language:javascript-typescript',
        `2026-11-20T10:00:${String(index % 60).padStart(2, '0')}Z`
      )
    );
    const commits = readRustAnalyzedCommits('owner/repo', (path) => {
      requested.push(path);
      return fullPage;
    });
    expect(commits).toEqual([]);
    expect(requested).toHaveLength(5);
  });

  test('a non-array page names the path and the received value', () => {
    expect(() =>
      readRustAnalyzedCommits('owner/repo', () => ({ message: 'Resource not accessible' }))
    ).toThrow('expected a JSON array of analyses; received {"message":"Resource not accessible"}');
  });

  test('a failed request propagates so the caller picks its fail-safe', () => {
    expect(() =>
      readRustAnalyzedCommits('owner/repo', () => {
        throw new Error('HTTP 403');
      })
    ).toThrow('HTTP 403');
  });
});

describe('resolveRustCoverage', () => {
  test('covers a docs-only change after the newest analyzed commit', () => {
    const diff = new FakeTreeDiff({ [sha('1')]: ['docs/guide.md'] });
    const result = resolveRustCoverage(HEAD, [sha('1')], diff.pathsBetween);
    expect(result).toMatchObject({ covered: true, base: sha('1') });
  });

  test('does not cover a Rust change, so a cancelled Rust commit still gets analyzed', () => {
    // A (Rust) was cancelled before its analysis; B (docs) follows. The diff from the
    // last analyzed commit to B contains A's Rust file, so B must analyze Rust.
    const diff = new FakeTreeDiff({
      [sha('1')]: ['crates/mango-protocol/src/lib.rs', 'docs/a.md'],
    });
    const result = resolveRustCoverage(HEAD, [sha('1')], diff.pathsBetween);
    expect(result.covered).toBe(false);
    expect(result.reason).toContain('Rust-relevant change');
  });

  test('covers identical trees, such as a revert of the analyzed change', () => {
    const diff = new FakeTreeDiff({ [sha('1')]: [] });
    expect(resolveRustCoverage(HEAD, [sha('1')], diff.pathsBetween).covered).toBe(true);
  });

  test('covers a head that has its own analyses without diffing', () => {
    const diff = new FakeTreeDiff({});
    const result = resolveRustCoverage(HEAD, [HEAD], diff.pathsBetween);
    expect(result.covered).toBe(true);
    expect(diff.asked).toEqual([]);
  });

  test('no candidate means not covered', () => {
    const result = resolveRustCoverage(HEAD, [], new FakeTreeDiff({}).pathsBetween);
    expect(result).toEqual({
      covered: false,
      reason: 'no main commit has an error-free analysis in both Rust categories',
    });
  });

  test('an unprovable difference is not coverage', () => {
    const diff = new FakeTreeDiff({ [sha('1')]: undefined });
    const result = resolveRustCoverage(HEAD, [sha('1')], diff.pathsBetween);
    expect(result.covered).toBe(false);
    expect(result.reason).toContain(`${sha('1')} (difference unproven)`);
  });

  test('falls back to an older candidate whose difference is provably irrelevant', () => {
    // The newest candidate carries a Rust change that was later reverted away from
    // the head's tree; the older one matches the head's Rust inputs.
    const diff = new FakeTreeDiff({ [sha('2')]: ['Cargo.lock'], [sha('1')]: ['README.md'] });
    const result = resolveRustCoverage(HEAD, [sha('2'), sha('1')], diff.pathsBetween);
    expect(result).toMatchObject({ covered: true, base: sha('1') });
  });

  test('tries only the newest bounded set of candidates', () => {
    const candidates = Array.from({ length: CODEQL_RUST_MAX_CANDIDATES + 2 }, (_, index) =>
      sha(String(index + 1))
    );
    const diffs = Object.fromEntries(candidates.map((candidate) => [candidate, ['Cargo.toml']]));
    const diff = new FakeTreeDiff(diffs);
    expect(resolveRustCoverage(HEAD, candidates, diff.pathsBetween).covered).toBe(false);
    expect(diff.asked).toEqual(candidates.slice(0, CODEQL_RUST_MAX_CANDIDATES));
  });

  test('both sides of a path list are judged by the CodeQL Rust pattern', () => {
    const diff = new FakeTreeDiff({ [sha('1')]: ['docs/old.md', 'crates/x/old.rs'] });
    expect(resolveRustCoverage(HEAD, [sha('1')], diff.pathsBetween).covered).toBe(false);
  });
});

describe('decideRustLegsForPush', () => {
  const analyzedPage = bothLegs(sha('1'), '2026-11-20T10:00:00Z');
  const input = (diff: FakeTreeDiff, fetchPage: () => unknown = () => analyzedPage) => ({
    head: HEAD,
    repository: 'owner/repo',
    fetchPage,
    pathsBetween: diff.pathsBetween,
  });

  test('skips the Rust legs when the head is covered', () => {
    const decision = decideRustLegsForPush(input(new FakeTreeDiff({ [sha('1')]: ['docs/a.md'] })));
    expect(decision.rust).toBe(false);
    expect(decision.reason).toContain(sha('1'));
  });

  test('runs the Rust legs when a Rust path changed since the last analysis', () => {
    const decision = decideRustLegsForPush(input(new FakeTreeDiff({ [sha('1')]: ['Cargo.lock'] })));
    expect(decision.rust).toBe(true);
  });

  test('runs the Rust legs when no analysis exists yet', () => {
    expect(decideRustLegsForPush(input(new FakeTreeDiff({}), () => [])).rust).toBe(true);
  });

  test('runs the Rust legs and names the failure when the analyses read fails', () => {
    const decision = decideRustLegsForPush(
      input(new FakeTreeDiff({}), () => {
        throw new Error('HTTP 502');
      })
    );
    expect(decision).toEqual({
      rust: true,
      reason: 'coverage lookup failed, analyzing Rust: HTTP 502',
    });
  });

  test('runs the Rust legs when the diff provider throws', () => {
    const decision = decideRustLegsForPush({
      ...input(new FakeTreeDiff({})),
      pathsBetween: () => {
        throw new Error('changed-paths: invalid repository-relative path: "/etc"');
      },
    });
    expect(decision.rust).toBe(true);
    expect(decision.reason).toContain('invalid repository-relative path');
  });
});

describe('currentRustAnalysisCommit', () => {
  test('is the commit holding the newest analysis of both categories', () => {
    const analyses = [
      ...bothLegs(sha('2'), '2026-11-22T10:00:00Z'),
      ...bothLegs(sha('1'), '2026-11-20T10:00:00Z'),
    ];
    expect(currentRustAnalysisCommit(analyses)).toBe(sha('2'));
  });

  test('is undefined when a newer single-category analysis sits on another commit', () => {
    const analyses = [
      analysis(sha('3'), '/language:rust/windows', '2026-11-23T10:00:00Z'),
      ...bothLegs(sha('2'), '2026-11-22T10:00:00Z'),
    ];
    expect(currentRustAnalysisCommit(analyses)).toBeUndefined();
  });

  test('is undefined when a category has no analysis', () => {
    expect(currentRustAnalysisCommit([])).toBeUndefined();
    expect(
      currentRustAnalysisCommit([analysis(sha('1'), '/language:rust', '2026-11-20T10:00:00Z')])
    ).toBeUndefined();
  });

  test('is undefined when two commits tie for the newest analysis of a category', () => {
    const analyses = [
      ...bothLegs(sha('1'), '2026-11-22T10:00:00Z'),
      analysis(sha('2'), '/language:rust', '2026-11-22T10:00:00Z'),
    ];
    expect(currentRustAnalysisCommit(analyses)).toBeUndefined();
  });

  test('an errored newer analysis does not move the baseline', () => {
    const analyses = [
      ...bothLegs(sha('2'), '2026-11-23T10:00:00Z', { error: 'upload failed' }),
      ...bothLegs(sha('1'), '2026-11-20T10:00:00Z'),
    ];
    expect(currentRustAnalysisCommit(analyses)).toBe(sha('1'));
  });
});

describe('decideRustLegsForPush keeps alerts current', () => {
  const pages = (analyses: unknown[]) => () => analyses;

  test('a revert of an analyzed Rust change is analyzed, not matched to the older analysis', () => {
    // R1 was analyzed, R2 changed Rust and was analyzed, HEAD reverts to R1's Rust state.
    // The older analysis matches HEAD, but code scanning holds R2's results as main's
    // state, so skipping would leave R2's alerts on the Security tab until the weekly run.
    const diff = new FakeTreeDiff({ [sha('1')]: [], [sha('2')]: ['crates/a/src/lib.rs'] });
    const decision = decideRustLegsForPush({
      head: HEAD,
      repository: 'owner/repo',
      fetchPage: pages([
        ...bothLegs(sha('2'), '2026-11-22T10:00:00Z'),
        ...bothLegs(sha('1'), '2026-11-20T10:00:00Z'),
      ]),
      pathsBetween: diff.pathsBetween,
    });
    expect(decision.rust).toBe(true);
    expect(diff.asked).toEqual([sha('2')]);
  });

  test('a newer single-category analysis on another commit forces analysis', () => {
    const diff = new FakeTreeDiff({ [sha('2')]: ['docs/a.md'] });
    const decision = decideRustLegsForPush({
      head: HEAD,
      repository: 'owner/repo',
      fetchPage: pages([
        analysis(sha('3'), '/language:rust/windows', '2026-11-23T10:00:00Z'),
        ...bothLegs(sha('2'), '2026-11-22T10:00:00Z'),
      ]),
      pathsBetween: diff.pathsBetween,
    });
    expect(decision.rust).toBe(true);
    expect(decision.reason).toContain('do not sit on one commit');
    expect(diff.asked).toEqual([]);
  });
});
