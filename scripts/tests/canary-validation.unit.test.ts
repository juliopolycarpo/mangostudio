import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CanaryValidationApi,
  type CanaryValidationSource,
  qualifyCanarySource,
} from '../lib/canary-validation';
import { fakeCliEnvironment, installFakeCli, removeFakeCliDirectory } from './support/fake-cli';
import { extractJobBlock } from './support/workflow-blocks';

const source: CanaryValidationSource = {
  repository: 'owner/repo',
  runId: 100,
  runAttempt: 2,
  sourceSha: 'a'.repeat(40),
  pushBeforeSha: 'b'.repeat(40),
};
const ciNames = [
  'CI Gate',
  'Distribution / Build immutable distribution',
  ...['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64', 'windows-arm64'].map(
    (platform) => `Smoke — Binary / Binary ${platform}`
  ),
  'Smoke — Container / Container transport',
];

function run(
  id: number,
  workflow: string,
  workflowId: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    workflow_id: workflowId,
    path: `.github/workflows/${workflow}`,
    repository: { full_name: source.repository },
    head_repository: { full_name: source.repository },
    head_sha: source.sourceSha,
    event: 'push',
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    run_attempt: 2,
    run_number: 20,
    ...overrides,
  };
}
function jobs(runId: number, names: readonly string[]) {
  return names.map((name, index) => ({
    id: runId * 100 + index,
    run_id: runId,
    name,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
  }));
}

class FakeQualificationApi implements CanaryValidationApi {
  readonly requests: string[] = [];
  readonly values = new Map<string, unknown>();
  constructor() {
    this.values.set('actions/workflows/ci.yml', { id: 42 });
    this.values.set(`git/commits/${source.sourceSha}`, {
      sha: source.sourceSha,
      tree: { sha: 'c'.repeat(40) },
    });
    this.values.set(`git/commits/${source.pushBeforeSha}`, {
      sha: source.pushBeforeSha,
      tree: { sha: 'd'.repeat(40) },
    });
    this.values.set('actions/runs/100/attempts/2', run(100, 'ci.yml', 42));
    this.values.set('actions/runs/100/jobs?filter=all&per_page=100', jobs(100, ciNames));
    this.values.set(`compare/${'b'.repeat(40)}...${source.sourceSha}`, {
      status: 'ahead',
      base_commit: { sha: 'b'.repeat(40) },
      merge_base_commit: { sha: 'b'.repeat(40) },
      files: [{ filename: 'README.md', status: 'modified' }],
    });
    for (const path of [
      'scripts/lib/rust-lanes.ts',
      'scripts/lib/protocol.ts',
      ...[
        'ci.yml',
        'distribution-build.yml',
        'smoke-binary.yml',
        'smoke-container.yml',
        'cargo-shim.yml',
        'protocol-ci.yml',
        'codeql.yml',
      ].map((name) => `.github/workflows/${name}`),
    ]) {
      this.values.set(`contents/${path}?ref=${source.sourceSha}`, {
        encoding: 'base64',
        content: readFileSync(path).toString('base64'),
      });
    }
    for (const [workflow, id, names] of [
      ['cargo-shim.yml', 43, ['Cargo Shim Gate']],
      ['protocol-ci.yml', 44, ['Protocol Gate']],
      [
        'codeql.yml',
        45,
        ['Analyze (javascript-typescript)', 'Analyze (rust)', 'Analyze (rust, windows)'],
      ],
    ] as const) {
      this.values.set(`actions/workflows/${workflow}`, { id });
      this.values.set(
        `actions/workflows/${id}/runs?branch=main&event=push&head_sha=${source.sourceSha}&per_page=100`,
        [run(id, workflow, id)]
      );
      this.values.set(`actions/runs/${id}/jobs?filter=all&per_page=100`, jobs(id, names));
    }
  }
  readonly failures = new Map<string, string>();
  get(path: string): unknown {
    this.requests.push(path);
    const key = path.replace('repos/owner/repo/', '');
    const failure = this.failures.get(key);
    if (failure) throw new Error(failure);
    if (!this.values.has(key)) throw new Error(`Unexpected GitHub API request: ${path}`);
    return this.values.get(key);
  }
  /** The CodeQL run succeeded with the Rust legs skipped by the relevance rule. */
  skipRustLegs() {
    // The runner keeps the unexpanded matrix expression as the name of a job skipped by `if`.
    const unexpanded = `Analyze (${'$'}{{ matrix.label }})`;
    const skipped = [unexpanded, unexpanded].map((name, index) => ({
      id: 4590 + index,
      run_id: 45,
      name,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'skipped',
    }));
    this.values.set('actions/runs/45/jobs?filter=all&per_page=100', [
      ...jobs(45, ['Analyze (javascript-typescript)']),
      ...skipped,
    ]);
  }
  /** Main's recorded analyses: one entry per category for each listed commit. */
  recordRustAnalyses(entries: readonly { commit: string; categories?: readonly string[] }[]) {
    this.values.set(
      'code-scanning/analyses?ref=refs/heads/main&tool_name=CodeQL&per_page=100&page=1',
      entries.flatMap(
        ({ commit, categories = ['/language:rust', '/language:rust/windows'] }, index) =>
          categories.map((category) => ({
            ref: 'refs/heads/main',
            commit_sha: commit,
            analysis_key: '.github/workflows/codeql.yml:analyze-rust',
            category,
            error: '',
            created_at: new Date(Date.UTC(2026, 10, 27, 12 - index)).toISOString(),
            tool: { name: 'CodeQL' },
          }))
      )
    );
  }
  /** `ancestor...descendant` as a clean, linear range changing `files`. */
  recordRange(ancestor: string, descendant: string, files: readonly string[]) {
    this.values.set(`compare/${ancestor}...${descendant}`, {
      status: files.length === 0 ? 'identical' : 'ahead',
      base_commit: { sha: ancestor },
      merge_base_commit: { sha: ancestor },
      files: files.map((filename) => ({ filename, status: 'modified' })),
    });
  }
  list(path: string, _key: string): readonly unknown[] {
    const value = this.get(path);
    if (!Array.isArray(value)) throw new Error(`Expected fake paginated array: ${path}`);
    return value;
  }
  updateRun(id: number, patch: Record<string, unknown>) {
    const key =
      id === 100
        ? 'actions/runs/100/attempts/2'
        : `actions/workflows/${id}/runs?branch=main&event=push&head_sha=${source.sourceSha}&per_page=100`;
    const previous = this.values.get(key);
    if (Array.isArray(previous)) this.values.set(key, [{ ...previous[0], ...patch }]);
    else this.values.set(key, { ...(previous as object), ...patch });
  }
  absent(id: number) {
    this.values.set(
      `actions/workflows/${id}/runs?branch=main&event=push&head_sha=${source.sourceSha}&per_page=100`,
      []
    );
  }
}

describe('canary required validation producers', () => {
  test('records exact CI and sibling workflow producers, including reused jobs from earlier attempts', () => {
    const result = qualifyCanarySource(source, new FakeQualificationApi());
    expect(result.builderAttempt).toBe(1);
    expect(result.ciJobs.map((job) => job.name)).toEqual(ciNames);
    expect(result.siblings.map((sibling) => [sibling.workflow, sibling.result])).toEqual([
      ['cargo-shim.yml', 'success'],
      ['protocol-ci.yml', 'success'],
      ['codeql.yml', 'success'],
    ]);
    expect(result.siblings[2]?.jobs.map((job) => job.name)).toEqual([
      'Analyze (javascript-typescript)',
      'Analyze (rust)',
      'Analyze (rust, windows)',
    ]);
  });
  for (const patch of [
    { status: 'in_progress', conclusion: null },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
    { event: 'pull_request' },
    { head_sha: 'c'.repeat(40) },
    { path: '.github/workflows/wrong.yml' },
    { repository: { full_name: 'fork/repo' } },
    { head_repository: { full_name: 'fork/repo' } },
    { head_branch: 'dev' },
    { workflow_id: 99 },
  ]) {
    test(`blocks invalid sibling verdict ${JSON.stringify(patch)}`, () => {
      const api = new FakeQualificationApi();
      api.updateRun(45, patch);
      expect(() => qualifyCanarySource(source, api)).toThrow(
        'codeql.yml: expected completed successful'
      );
    });
  }
  test('a cache-seed failure leaves CI unsuccessful and disqualifies the source', () => {
    const api = new FakeQualificationApi();
    api.updateRun(100, { conclusion: 'failure' });
    expect(() => qualifyCanarySource(source, api)).toThrow('ci.yml: expected completed successful');
  });
  test('a frozen run cannot silently advance to a rerun attempt', () => {
    const api = new FakeQualificationApi();
    api.updateRun(100, { run_attempt: 3 });
    expect(() => qualifyCanarySource(source, api)).toThrow('expected 100 attempt 2');
  });
  test('a same-source sibling workflow is mandatory when its path filter is relevant', () => {
    const api = new FakeQualificationApi();
    api.absent(43);
    api.absent(44);
    api.values.set(`compare/${'b'.repeat(40)}...${source.sourceSha}`, {
      status: 'ahead',
      base_commit: { sha: 'b'.repeat(40) },
      merge_base_commit: { sha: 'b'.repeat(40) },
      files: [{ filename: 'spec/schema.json' }],
    });
    expect(() => qualifyCanarySource(source, api)).toThrow('cargo-shim.yml: expected same-SHA');
  });
  test('accepts absent path-filtered siblings only with a complete irrelevant push comparison', () => {
    const api = new FakeQualificationApi();
    api.absent(43);
    api.absent(44);
    const receipt = qualifyCanarySource(source, api);
    expect(receipt.siblings.map((sibling) => sibling.result)).toEqual([
      'not-triggered',
      'not-triggered',
      'success',
    ]);
    expect(receipt.relevance).toMatchObject({ cargo: false, protocol: false });
  });
  test('accepts absent filtered siblings after an attested equal-tree history rewrite', () => {
    const api = new FakeQualificationApi();
    api.absent(43);
    api.absent(44);
    api.values.set(`compare/${source.pushBeforeSha}...${source.sourceSha}`, { status: 'diverged' });
    api.values.set(`git/commits/${source.pushBeforeSha}`, {
      sha: source.pushBeforeSha,
      tree: { sha: 'c'.repeat(40) },
    });
    const receipt = qualifyCanarySource(source, api);
    expect(receipt.relevance).toMatchObject({ cargo: false, protocol: false });
    expect(receipt.relevance.reason).toContain('identical root trees');
  });

  test.each([
    { sha: 'e'.repeat(40), tree: { sha: 'c'.repeat(40) } },
    { sha: source.sourceSha, tree: { sha: 'not-a-tree' } },
    { sha: source.sourceSha, tree: { sha: 'C'.repeat(40) } },
  ])('refuses unbound commit/tree evidence %j', (commit) => {
    const api = new FakeQualificationApi();
    api.values.set(`compare/${source.pushBeforeSha}...${source.sourceSha}`, { status: 'diverged' });
    api.values.set(`git/commits/${source.sourceSha}`, commit);
    expect(() => qualifyCanarySource(source, api)).toThrow('expected commit');
  });

  test.each(['failure', 'cancelled'])(
    'equal trees never waive an existing %s sibling',
    (conclusion) => {
      const api = new FakeQualificationApi();
      api.values.set(`compare/${source.pushBeforeSha}...${source.sourceSha}`, {
        status: 'diverged',
      });
      api.values.set(`git/commits/${source.pushBeforeSha}`, {
        sha: source.pushBeforeSha,
        tree: { sha: 'c'.repeat(40) },
      });
      api.updateRun(43, { conclusion });
      expect(() => qualifyCanarySource(source, api)).toThrow(
        'cargo-shim.yml: expected completed successful'
      );
    }
  );

  test('requires every platform in the binary smoke producer matrix', () => {
    const receipt = qualifyCanarySource(source, new FakeQualificationApi());
    const block = extractJobBlock(
      readFileSync('.github/workflows/smoke-binary.yml', 'utf8'),
      'binary'
    );
    const platforms = [...block.matchAll(/^ {10}- platform: (\S+)$/gm)].map((match) => match[1]);
    expect(platforms.length).toBeGreaterThan(0);
    expect(
      receipt.ciJobs
        .filter((job) => job.name.startsWith('Smoke — Binary / Binary '))
        .map((job) => job.name)
        .sort()
    ).toEqual(platforms.map((platform) => `Smoke — Binary / Binary ${platform}`).sort());
  });
  test('requires every analysis in the CodeQL producer matrix', () => {
    const receipt = qualifyCanarySource(source, new FakeQualificationApi());
    const workflow = readFileSync('.github/workflows/codeql.yml', 'utf8');
    // The Rust legs live in their own job so pull requests can skip them.
    const labels = ['analyze', 'analyze-rust'].flatMap((job) =>
      [...extractJobBlock(workflow, job).matchAll(/^ {12}label: (.+)$/gm)].map((match) => match[1])
    );
    expect(labels).toHaveLength(3);
    expect(
      receipt.siblings
        .find((sibling) => sibling.workflow === 'codeql.yml')
        ?.jobs.map((job) => job.name)
        .sort()
    ).toEqual(labels.map((label) => `Analyze (${label})`).sort());
  });
  test('ambiguous same-SHA sibling producers fail instead of choosing an arbitrary run', () => {
    const api = new FakeQualificationApi();
    api.values.set(
      `actions/workflows/45/runs?branch=main&event=push&head_sha=${source.sourceSha}&per_page=100`,
      [run(45, 'codeql.yml', 45), run(46, 'codeql.yml', 45)]
    );
    expect(() => qualifyCanarySource(source, api)).toThrow('ambiguous same-SHA run number 20');
  });
  test('CodeQL absence is never a path-filtered skip', () => {
    const api = new FakeQualificationApi();
    api.absent(45);
    expect(() => qualifyCanarySource(source, api)).toThrow('codeql.yml: expected same-SHA');
  });
  describe('CodeQL Rust legs skipped by the relevance rule', () => {
    const analyzed = 'e'.repeat(40);

    function skippedApi() {
      const api = new FakeQualificationApi();
      api.skipRustLegs();
      api.values.set(`contents/scripts/lib/ci-lanes.ts?ref=${source.sourceSha}`, {
        encoding: 'base64',
        content: readFileSync('scripts/lib/ci-lanes.ts').toString('base64'),
      });
      return api;
    }

    test('both Rust legs analyzed on the SHA never consult the analyses API', () => {
      const api = new FakeQualificationApi();
      const receipt = qualifyCanarySource(source, api);
      expect(receipt.codeqlRust).toMatchObject({ analyzed: true });
      expect(api.requests.filter((path) => path.includes('code-scanning'))).toEqual([]);
    });

    test('accepts skipped legs when an earlier analysis differs only by non-Rust paths', () => {
      const api = skippedApi();
      api.recordRustAnalyses([{ commit: analyzed }]);
      api.recordRange(analyzed, source.sourceSha, ['docs/guide.md', 'apps/api/src/index.ts']);
      const receipt = qualifyCanarySource(source, api);
      expect(receipt.codeqlRust).toMatchObject({ analyzed: false });
      expect(receipt.codeqlRust?.reason).toContain(analyzed);
      expect(
        receipt.siblings
          .find((sibling) => sibling.workflow === 'codeql.yml')
          ?.jobs.map((job) => job.name)
      ).toEqual(['Analyze (javascript-typescript)']);
    });

    test('accepts a later analysis whose Rust inputs equal the source', () => {
      const api = skippedApi();
      const later = 'd'.repeat(40);
      api.recordRustAnalyses([{ commit: later }]);
      // Source is the ancestor: compare later...source is 'behind', source...later is the real range.
      api.values.set(`compare/${later}...${source.sourceSha}`, {
        status: 'behind',
        base_commit: { sha: later },
        merge_base_commit: { sha: source.sourceSha },
        files: [],
      });
      api.recordRange(source.sourceSha, later, ['README.md']);
      expect(qualifyCanarySource(source, api).codeqlRust?.analyzed).toBe(false);
    });

    test('rejects a Rust change whose own analysis was cancelled and a docs commit followed', () => {
      // A (Rust) was superseded before analyzing; the SHA is docs-only after A. The
      // last analyzed commit differs from the SHA by A's Rust file, so the SHA is not covered.
      const api = skippedApi();
      api.recordRustAnalyses([{ commit: analyzed }]);
      api.recordRange(analyzed, source.sourceSha, [
        'docs/guide.md',
        'crates/mango-protocol/src/lib.rs',
      ]);
      expect(() => qualifyCanarySource(source, api)).toThrow(
        `no earlier or later main analysis covers it; expected a commit with Analyze (rust) and Analyze (rust, windows) analyses and no CodeQL-Rust-relevant path difference; received no candidate covers ${source.sourceSha}: ${analyzed} (Rust-relevant change)`
      );
    });

    test('rejects when no commit has both Rust analyses', () => {
      const api = skippedApi();
      api.recordRustAnalyses([{ commit: analyzed, categories: ['/language:rust'] }]);
      expect(() => qualifyCanarySource(source, api)).toThrow(
        'received no main commit has an error-free analysis in both Rust categories'
      );
    });

    test('rejects a diverged candidate because its compare file list is not the real diff', () => {
      const api = skippedApi();
      api.recordRustAnalyses([{ commit: analyzed }]);
      for (const range of [
        `compare/${analyzed}...${source.sourceSha}`,
        `compare/${source.sourceSha}...${analyzed}`,
      ])
        api.values.set(range, { status: 'diverged', files: [{ filename: 'README.md' }] });
      expect(() => qualifyCanarySource(source, api)).toThrow(`${analyzed} (difference unproven)`);
    });

    test('rejects a comparison that may be truncated at 300 files', () => {
      const api = skippedApi();
      api.recordRustAnalyses([{ commit: analyzed }]);
      api.values.set(`compare/${analyzed}...${source.sourceSha}`, {
        status: 'ahead',
        base_commit: { sha: analyzed },
        merge_base_commit: { sha: analyzed },
        files: Array.from({ length: 300 }, () => ({ filename: 'README.md' })),
      });
      api.values.set(`compare/${source.sourceSha}...${analyzed}`, { status: 'diverged' });
      expect(() => qualifyCanarySource(source, api)).toThrow(`${analyzed} (difference unproven)`);
    });

    test('rejects when the analyses lookup fails instead of assuming coverage', () => {
      const api = skippedApi();
      api.failures.set(
        'code-scanning/analyses?ref=refs/heads/main&tool_name=CodeQL&per_page=100&page=1',
        'HTTP 403: Resource not accessible by integration'
      );
      expect(() => qualifyCanarySource(source, api)).toThrow('HTTP 403');
    });

    test('rejects a source whose relevance predicate differs from the qualification revision', () => {
      const api = skippedApi();
      api.values.set(`contents/scripts/lib/ci-lanes.ts?ref=${source.sourceSha}`, {
        encoding: 'base64',
        content: Buffer.from('const CODEQL_RUST_PATTERN = /nothing/;').toString('base64'),
      });
      api.recordRustAnalyses([{ commit: analyzed }]);
      api.recordRange(analyzed, source.sourceSha, ['docs/guide.md']);
      expect(() => qualifyCanarySource(source, api)).toThrow(
        `scripts/lib/ci-lanes.ts at ${source.sourceSha} differs from the qualification revision`
      );
    });

    test('a failed Rust leg is never treated as skipped', () => {
      const api = skippedApi();
      api.values.set('actions/runs/45/jobs?filter=all&per_page=100', [
        ...jobs(45, ['Analyze (javascript-typescript)', 'Analyze (rust)']),
        { ...jobs(45, ['Analyze (rust, windows)'])[0], conclusion: 'failure' },
      ]);
      expect(() => qualifyCanarySource(source, api)).toThrow(
        'expected completed successful associated job'
      );
    });

    test('one analyzed and one skipped Rust leg is a partial verdict', () => {
      const api = skippedApi();
      api.values.set('actions/runs/45/jobs?filter=all&per_page=100', [
        ...jobs(45, ['Analyze (javascript-typescript)', 'Analyze (rust)']),
        { ...jobs(45, ['Analyze (rust, windows)'])[0], conclusion: 'skipped' },
      ]);
      expect(() => qualifyCanarySource(source, api)).toThrow(
        'expected both Rust analyses to succeed or both to be skipped'
      );
    });

    test('the JavaScript analysis stays required when the Rust legs are skipped', () => {
      const api = skippedApi();
      api.values.set('actions/runs/45/jobs?filter=all&per_page=100', []);
      api.recordRustAnalyses([{ commit: analyzed }]);
      api.recordRange(analyzed, source.sourceSha, ['docs/guide.md']);
      expect(() => qualifyCanarySource(source, api)).toThrow(
        'Analyze (javascript-typescript): expected exactly one latest producer'
      );
    });
  });
  for (const comparison of [
    { status: 'diverged' },
    { status: 'ahead', base_commit: { sha: 'c'.repeat(40) } },
    {
      status: 'ahead',
      base_commit: { sha: 'b'.repeat(40) },
      merge_base_commit: { sha: 'b'.repeat(40) },
      // Missing file list is unproven; an explicit empty list is valid.
    },
    {
      status: 'ahead',
      base_commit: { sha: 'b'.repeat(40) },
      merge_base_commit: { sha: 'b'.repeat(40) },
      files: Array.from({ length: 300 }, () => ({ filename: 'README.md' })),
    },
  ]) {
    test(`unproven or truncated push range requires siblings: ${comparison.status}`, () => {
      const api = new FakeQualificationApi();
      api.absent(43);
      api.values.set(`compare/${'b'.repeat(40)}...${source.sourceSha}`, comparison);
      expect(() => qualifyCanarySource(source, api)).toThrow('exact push range unproven');
    });
  }
  test('changed producer contracts reject an older source despite matching job names', () => {
    const api = new FakeQualificationApi();
    api.values.set(`contents/.github/workflows/smoke-binary.yml?ref=${source.sourceSha}`, {
      encoding: 'base64',
      content: Buffer.from('different smoke coverage').toString('base64'),
    });
    expect(() => qualifyCanarySource(source, api)).toThrow(
      'source validation contract differs from qualification revision'
    );
  });
  test('legacy runs without verified exact push evidence require both siblings', () => {
    const api = new FakeQualificationApi();
    api.absent(43);
    expect(() => qualifyCanarySource({ ...source, pushBeforeSha: undefined }, api)).toThrow(
      'exact push range unproven'
    );
    expect(api.requests.some((path) => path.includes('/compare/'))).toBe(false);
  });
  test('source predicate changes require siblings instead of trusting execution-revision skip rules', () => {
    const api = new FakeQualificationApi();
    api.absent(43);
    api.values.set(`contents/scripts/lib/rust-lanes.ts?ref=${source.sourceSha}`, {
      encoding: 'base64',
      content: Buffer.from('older rules').toString('base64'),
    });
    expect(() => qualifyCanarySource(source, api)).toThrow('differs from qualification policy');
  });
  test('renames include the old path in relevance', () => {
    const api = new FakeQualificationApi();
    api.absent(44);
    api.values.set(`compare/${'b'.repeat(40)}...${source.sourceSha}`, {
      status: 'ahead',
      base_commit: { sha: 'b'.repeat(40) },
      merge_base_commit: { sha: 'b'.repeat(40) },
      files: [{ filename: 'README.md', status: 'renamed', previous_filename: 'spec/input.json' }],
    });
    expect(() => qualifyCanarySource(source, api)).toThrow('protocol-ci.yml: expected same-SHA');
  });
  for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
    test(`smoke ${conclusion} blocks promotion despite successful Gate`, () => {
      const api = new FakeQualificationApi();
      api.values.set(
        'actions/runs/100/jobs?filter=all&per_page=100',
        jobs(100, ciNames).map((job) => (job.name === ciNames[2] ? { ...job, conclusion } : job))
      );
      expect(() => qualifyCanarySource(source, api)).toThrow(
        'expected completed successful associated job'
      );
    });
  }
  test('an older successful job cannot hide a failed rerun job', () => {
    const api = new FakeQualificationApi();
    api.values.set('actions/runs/100/jobs?filter=all&per_page=100', [
      ...jobs(100, ciNames),
      { ...jobs(100, ciNames)[2], run_attempt: 2, conclusion: 'failure' },
    ]);
    expect(() => qualifyCanarySource(source, api)).toThrow(
      'expected completed successful associated job'
    );
  });
  test('rebuilding the distribution invalidates older smoke qualification', () => {
    const api = new FakeQualificationApi();
    api.values.set(
      'actions/runs/100/jobs?filter=all&per_page=100',
      jobs(100, ciNames).map((job) =>
        job.name === ciNames[1] || job.name === 'CI Gate' ? { ...job, run_attempt: 2 } : job
      )
    );
    expect(() => qualifyCanarySource(source, api)).toThrow(
      'predates distribution builder attempt 2'
    );
  });
  test('missing and ambiguous mandatory jobs cannot be interpreted as successful skips', () => {
    const api = new FakeQualificationApi();
    api.values.set('actions/runs/100/jobs?filter=all&per_page=100', jobs(100, ciNames).slice(1));
    expect(() => qualifyCanarySource(source, api)).toThrow('CI Gate: expected exactly one');
    api.values.set('actions/runs/100/jobs?filter=all&per_page=100', [
      ...jobs(100, ciNames),
      ...jobs(100, ['CI Gate']),
    ]);
    expect(() => qualifyCanarySource(source, api)).toThrow('CI Gate: expected exactly one');
  });
  test('authentication or API read failures propagate without granting eligibility', () => {
    const api = new FakeQualificationApi();
    api.values.delete('actions/workflows/codeql.yml');
    expect(() => qualifyCanarySource(source, api)).toThrow('Unexpected GitHub API request');
  });
  test('rejects malformed selection values before any API request', () => {
    const api = new FakeQualificationApi();
    expect(() => qualifyCanarySource({ ...source, sourceSha: 'main' }, api)).toThrow(
      'full source SHA'
    );
    expect(() => qualifyCanarySource({ ...source, runId: 0 }, api)).toThrow(
      'expected positive safe integer'
    );
    expect(api.requests).toEqual([]);
  });
});

const fakeQualificationGitHubCli = `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (process.env.FAKE_API_FAILURE === 'true') { console.error('fixture denied API read'); process.exit(1); }
const path = args.at(-1).replace('repos/owner/repo/', '');
const values = JSON.parse(await Bun.file(process.env.FAKE_API_VALUES).text());
if (!(path in values)) { console.error('Unexpected API request: ' + path); process.exit(2); }
const value = values[path];
if (args.includes('--paginate')) {
  if (process.env.FAKE_MALFORMED_PAGE === 'true') console.log(JSON.stringify([{}]));
  else if (process.env.FAKE_EMPTY_PAGES === 'true') console.log('[]');
  else console.log(JSON.stringify([{
    ...(process.env.FAKE_MISSING_COUNT === 'true' ? {} : { total_count: value.length + (process.env.FAKE_INCOMPLETE_PAGES === 'true' ? 1 : 0) }),
    [path.includes('/jobs?') ? 'jobs' : 'workflow_runs']: value,
  }]));
} else console.log(JSON.stringify(value));
`;

test.each([
  'success',
  'api-failure',
  'malformed-page',
  'missing-count',
  'incomplete-pages',
  'empty-pages',
])(
  'qualification CLI: %s',
  (scenario) => {
    const directory = mkdtempSync(join(tmpdir(), 'canary-qualification-cli-'));
    try {
      const api = new FakeQualificationApi();
      const apiValues = join(directory, 'api.json');
      writeFileSync(apiValues, JSON.stringify(Object.fromEntries(api.values)));
      installFakeCli(directory, 'gh', fakeQualificationGitHubCli);
      const output = join(directory, 'output');
      const receiptPath = join(directory, 'receipt.json');
      const result = Bun.spawnSync(['bun', './scripts/ci/qualify-canary-source.ts'], {
        env: {
          ...fakeCliEnvironment(directory),
          REPO: source.repository,
          SOURCE_RUN_ID: String(source.runId),
          SOURCE_RUN_ATTEMPT: String(source.runAttempt),
          SOURCE_SHA: source.sourceSha,
          VERIFIED_PUSH_BEFORE_SHA: source.pushBeforeSha,
          QUALIFICATION_RECEIPT: receiptPath,
          GITHUB_OUTPUT: output,
          FAKE_API_VALUES: apiValues,
          FAKE_API_FAILURE: String(scenario === 'api-failure'),
          FAKE_MALFORMED_PAGE: String(scenario === 'malformed-page'),
          FAKE_MISSING_COUNT: String(scenario === 'missing-count'),
          FAKE_INCOMPLETE_PAGES: String(scenario === 'incomplete-pages'),
          FAKE_EMPTY_PAGES: String(scenario === 'empty-pages'),
        },
      });
      expect(result.exitCode).toBe(scenario === 'success' ? 0 : 1);
      if (scenario === 'success') {
        expect(readFileSync(output, 'utf8')).toBe('builder_attempt=1\nqualified=true\n');
        expect(JSON.parse(readFileSync(receiptPath, 'utf8')).source).toEqual(source);
      } else {
        expect(existsSync(receiptPath)).toBe(false);
        expect(existsSync(output)).toBe(false);
        expect(result.stderr.toString()).toContain(
          scenario === 'api-failure'
            ? 'fixture denied API read'
            : scenario === 'malformed-page'
              ? 'expected page.jobs array'
              : scenario === 'missing-count'
                ? 'expected page.total_count nonnegative safe integer'
                : scenario === 'incomplete-pages'
                  ? 'expected complete jobs collection'
                  : 'expected nonempty paginated array'
        );
      }
    } finally {
      removeFakeCliDirectory(directory);
    }
    // The success scenario reads every fixture value: about 13 fake gh calls,
    // each a launcher and a Bun start on Windows. That took 0.5 to 1.7 s on an
    // idle runner and past 15 s beside two root workers and api-unit (#2661).
  },
  60_000
);

test.each([true, null, 'false', 0])(
  'refuses explicitly truncated or malformed comparison marker %j',
  (truncated) => {
    const api = new FakeQualificationApi();
    api.absent(43);
    api.values.set(`compare/${'b'.repeat(40)}...${source.sourceSha}`, {
      status: 'ahead',
      base_commit: { sha: 'b'.repeat(40) },
      merge_base_commit: { sha: 'b'.repeat(40) },
      files: [{ filename: 'README.md', status: 'modified' }],
      truncated,
    });
    expect(() => qualifyCanarySource(source, api)).toThrow('exact push range unproven');
  }
);

test('accepts an authenticated exact push range with no net file changes', () => {
  const api = new FakeQualificationApi();
  api.absent(43);
  api.absent(44);
  api.values.set(`compare/${'b'.repeat(40)}...${source.sourceSha}`, {
    status: 'ahead',
    base_commit: { sha: 'b'.repeat(40) },
    merge_base_commit: { sha: 'b'.repeat(40) },
    files: [],
  });
  expect(qualifyCanarySource(source, api).siblings.map((sibling) => sibling.result)).toEqual([
    'not-triggered',
    'not-triggered',
    'success',
  ]);
});

test('qualifies the frozen successful attempt while a later rerun changes mutable run metadata', () => {
  const api = new FakeQualificationApi();
  api.values.set('actions/runs/100/attempts/2', run(100, 'ci.yml', 42));
  api.values.set(
    'actions/runs/100',
    run(100, 'ci.yml', 42, { run_attempt: 3, status: 'in_progress', conclusion: null })
  );
  const previous = jobs(100, ciNames);
  api.values.set('actions/runs/100/jobs?filter=all&per_page=100', [
    ...previous,
    ...previous.map((job) => ({
      ...job,
      id: job.id + 10000,
      run_attempt: 3,
      status: 'in_progress',
      conclusion: null,
    })),
  ]);
  expect(qualifyCanarySource(source, api).source.runAttempt).toBe(2);
  expect(api.requests).toContain('repos/owner/repo/actions/runs/100/attempts/2');
  expect(api.requests).not.toContain('repos/owner/repo/actions/runs/100');
});
