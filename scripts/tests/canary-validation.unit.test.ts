import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { qualifyCanarySourceToFiles } from '../ci/qualify-canary-source';
import { createCanaryGhApi } from '../lib/canary-gh-api';
import {
  type CanaryValidationApi,
  type CanaryValidationSource,
  qualifyCanarySource,
} from '../lib/canary-validation';
import { GitHubRetry, STANDARD_RETRY_POLICY } from '../lib/github-retry';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';
import { runtimeBuildJobName, runtimeReuseArtifactName } from '../lib/runtime-base-reuse';
import { fakeCliEnvironment, installFakeCli, removeFakeCliDirectory } from './support/fake-cli';
import { ghFailure, ghServing, ScriptedGhRunner } from './support/scripted-gh-runner';
import { RecordedRetryEnvironment } from './support/scripted-github-http';
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
/** The runtime build job of every release platform, named as the Actions API names it. */
const runtimeNames = ALL_BINARY_TARGETS.map((target) => runtimeBuildJobName(target.arch));
/** Every job of the source run the qualification reads. */
const runNames = [...ciNames, ...runtimeNames];

/** Workflow ID and the jobs that prove a lane ran, for candidate commits other than the source. */
const evidenceLanes = {
  'cargo-shim.yml': { id: 43, jobs: ['Cargo Shim Gate'] },
  // A green Protocol Gate alone can mean the compiled matrix was skipped for a prose-only push.
  'protocol-ci.yml': {
    id: 44,
    jobs: ['Protocol Gate', 'TypeScript', 'cargo-deny', 'Schema equality and round trip'],
  },
  'codeql.yml': { id: 45, jobs: ['Analyze (rust)', 'Analyze (rust, windows)'] },
} as const;
/** A commit before the source whose Cargo Shim and Protocol CI runs on main were green. */
const earlierGreen = 'e'.repeat(40);

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
    started_at: '2026-11-28T09:00:00Z',
    completed_at: '2026-11-28T09:10:00Z',
    // What a runtime job always has; the reuse rule reads its step conclusions.
    steps: [{ name: 'Build runtime', number: 1, status: 'completed', conclusion: 'success' }],
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
    this.values.set('actions/runs/100/jobs?filter=all&per_page=100', jobs(100, runNames));
    // No runtime reused a base: the source run holds no reuse record.
    this.values.set('actions/runs/100/artifacts?per_page=100', []);
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
        'runtime-build.yml',
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
      // A push that ran the compiled matrix: Gate plus the matrix-free jobs.
      ['protocol-ci.yml', 44, evidenceLanes['protocol-ci.yml'].jobs],
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
  /**
   * The Actions side of a candidate: the codeql.yml run for `commit` with its Rust jobs and
   * the pinned workflow bytes. Defaults describe a green push run on main.
   */
  recordCandidateRun(
    commit: string,
    options: {
      branch?: string;
      event?: string;
      rustConclusion?: string;
      windowsConclusion?: string;
      workflowBytes?: string;
    } = {}
  ) {
    this.recordWorkflowRun('codeql.yml', commit, {
      ...options,
      conclusions: [options.rustConclusion, options.windowsConclusion],
    });
  }
  /**
   * Actions evidence for `commit` in any lane workflow: its run listing keyed by head SHA, the
   * jobs of that run and the workflow bytes at the commit. Defaults describe a green push run on
   * main with every evidence job successful; `conclusions` overrides jobs by position.
   */
  recordWorkflowRun(
    workflow: keyof typeof evidenceLanes,
    commit: string,
    options: {
      branch?: string;
      event?: string;
      workflowBytes?: string;
      conclusions?: readonly (string | undefined)[];
    } = {}
  ) {
    const { id, jobs: names } = evidenceLanes[workflow];
    // The workflow ID is part of the run ID so one commit can carry runs in several lanes.
    const runId = 7000 + (id - 45) * 1000 + parseInt(commit.slice(0, 2), 16);
    this.values.set(`contents/.github/workflows/${workflow}?ref=${commit}`, {
      encoding: 'base64',
      content: Buffer.from(
        options.workflowBytes ?? readFileSync(`.github/workflows/${workflow}`, 'utf8')
      ).toString('base64'),
    });
    this.values.set(`actions/workflows/${id}/runs?branch=main&head_sha=${commit}&per_page=100`, [
      run(runId, workflow, id, {
        head_sha: commit,
        head_branch: options.branch ?? 'main',
        event: options.event ?? 'push',
      }),
    ]);
    this.values.set(
      `actions/runs/${runId}/jobs?filter=all&per_page=100`,
      jobs(runId, names).map((job, index) => ({
        ...job,
        conclusion: options.conclusions?.[index] ?? 'success',
      }))
    );
  }
  /**
   * The newest-first runs the lane workflow lists for main, one bounded page per event (`push`
   * unless a row says `workflow_dispatch`). Both pages always exist, as the real API answers an
   * empty page. Rows only nominate: `conclusion` is what the row claims, and `runNumber`
   * defaults to a descending sequence from 500.
   */
  recordLaneNominations(
    workflow: keyof typeof evidenceLanes,
    rows: readonly {
      commit: string;
      conclusion?: string;
      event?: 'push' | 'workflow_dispatch';
      runNumber?: number;
    }[]
  ) {
    const { id } = evidenceLanes[workflow];
    for (const event of ['push', 'workflow_dispatch'] as const) {
      const page = rows.filter((row) => (row.event ?? 'push') === event);
      this.values.set(
        `actions/workflows/${id}/runs?branch=main&event=${event}&status=success&per_page=20`,
        {
          total_count: page.length,
          workflow_runs: page.map((row, index) =>
            run(9000 + index, workflow, id, {
              event,
              head_sha: row.commit,
              conclusion: row.conclusion ?? 'success',
              run_number: row.runNumber ?? 500 - index,
            })
          ),
        }
      );
    }
  }
  /**
   * A full push page of green runs older than anything else listed, on commits no test covers.
   * The page is as full as the API's per_page, so a lister that read only it would see no
   * covering run if the real one sat in another event's page.
   */
  recordFullPushPageOfOlderRuns(workflow: keyof typeof evidenceLanes, coveringRun: string) {
    const unrelated = Array.from({ length: 20 }, (_, index) => ({
      commit: (index + 10).toString(16).padStart(2, '0').repeat(20),
      runNumber: 100 - index,
    }));
    this.recordLaneNominations(workflow, [
      ...unrelated,
      { commit: coveringRun, event: 'workflow_dispatch', runNumber: 600 },
    ]);
  }
  /**
   * Both lanes covered by a green push run on `commit`, with a docs-only range to the source.
   * This is what a path-filtered skip needs from main's history.
   */
  coverLanesFrom(commit: string) {
    for (const workflow of ['cargo-shim.yml', 'protocol-ci.yml'] as const) {
      this.recordLaneNominations(workflow, [{ commit }]);
      this.recordWorkflowRun(workflow, commit);
    }
    this.recordRange(commit, source.sourceSha, ['docs/guide.md']);
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
    api.coverLanesFrom(earlierGreen);
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
    api.coverLanesFrom(earlierGreen);
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
  describe('Cargo Shim and Protocol CI skipped by the push path filter', () => {
    const rustCommit = source.pushBeforeSha as string;
    const otherCommit = 'f'.repeat(40);
    const nominationPath = (id: number, event: 'push' | 'workflow_dispatch') =>
      `actions/workflows/${id}/runs?branch=main&event=${event}&status=success&per_page=20`;
    const cargoRelevant = ['crates/mango-protocol/src/lib.rs', 'docs/guide.md'];

    /** The scenario of #2726: Z is green, Rust commit A was cancelled, and the source is docs-only. */
    function docsAfterCancelledRustApi() {
      const api = new FakeQualificationApi();
      api.absent(43);
      api.absent(44);
      for (const workflow of ['cargo-shim.yml', 'protocol-ci.yml'] as const) {
        api.recordLaneNominations(workflow, [
          { commit: rustCommit, conclusion: 'cancelled' },
          { commit: earlierGreen },
        ]);
        api.recordWorkflowRun(workflow, earlierGreen);
      }
      api.recordRange(earlierGreen, source.sourceSha, cargoRelevant);
      return api;
    }

    /** Cargo Shim is covered by a green docs-only predecessor; Protocol CI is the variable. */
    function protocolOnlyApi() {
      const api = new FakeQualificationApi();
      api.absent(43);
      api.absent(44);
      api.recordLaneNominations('cargo-shim.yml', [{ commit: earlierGreen }]);
      api.recordWorkflowRun('cargo-shim.yml', earlierGreen);
      api.recordRange(earlierGreen, source.sourceSha, ['docs/guide.md']);
      api.recordLaneNominations('protocol-ci.yml', [{ commit: otherCommit }]);
      api.recordWorkflowRun('protocol-ci.yml', otherCommit);
      api.recordRange(otherCommit, source.sourceSha, ['docs/guide.md']);
      return api;
    }

    test('rejects a docs commit after a Rust commit whose Cargo Shim run was cancelled', () => {
      expect(() => qualifyCanarySource(source, docsAfterCancelledRustApi())).toThrow(
        `cargo-shim.yml: expected a covering main run for ${source.sourceSha}; received no candidate covers ${source.sourceSha}: ${earlierGreen} (Cargo Shim-relevant change)`
      );
    });

    test('rejects the same history when only Protocol CI is uncovered', () => {
      const api = protocolOnlyApi();
      api.recordRange(otherCommit, source.sourceSha, ['spec/schema/1/protocol.json']);
      expect(() => qualifyCanarySource(source, api)).toThrow(
        `protocol-ci.yml: expected a covering main run for ${source.sourceSha}; received no candidate covers ${source.sourceSha}: ${otherCommit} (Protocol CI-relevant change)`
      );
    });

    test('names the recovery in the rejection', () => {
      expect(() => qualifyCanarySource(source, docsAfterCancelledRustApi())).toThrow(
        'To recover, re-run the cancelled or failed cargo-shim.yml run of the newest Cargo Shim-relevant commit on main'
      );
    });

    test('accepts a docs commit after a Rust commit whose runs were green', () => {
      const api = new FakeQualificationApi();
      api.absent(43);
      api.absent(44);
      api.coverLanesFrom(rustCommit);
      const receipt = qualifyCanarySource(source, api);
      expect(receipt.siblings.map((sibling) => sibling.result)).toEqual([
        'not-triggered',
        'not-triggered',
        'success',
      ]);
      expect(receipt.laneCoverage?.cargo).toMatchObject({ ranOnSource: false });
      expect(receipt.laneCoverage?.cargo.reason).toContain(rustCommit);
      expect(receipt.laneCoverage?.protocol).toMatchObject({ ranOnSource: false });
    });

    test('a lane that ran on the source needs no earlier run and never lists nominations', () => {
      const api = new FakeQualificationApi();
      const receipt = qualifyCanarySource(source, api);
      expect(receipt.laneCoverage).toEqual({
        cargo: { ranOnSource: true, reason: `Cargo Shim ran on ${source.sourceSha}` },
        protocol: { ranOnSource: true, reason: `Protocol CI ran on ${source.sourceSha}` },
      });
      expect(api.requests.filter((path) => path.includes('status=success'))).toEqual([]);
    });

    test('accepts a later green run whose relevant inputs equal the source', () => {
      const api = new FakeQualificationApi();
      api.absent(43);
      api.absent(44);
      for (const workflow of ['cargo-shim.yml', 'protocol-ci.yml'] as const) {
        api.recordLaneNominations(workflow, [{ commit: earlierGreen }]);
        api.recordWorkflowRun(workflow, earlierGreen);
      }
      // Source is the ancestor: earlierGreen...source is 'behind', source...earlierGreen is the real range.
      api.values.set(`compare/${earlierGreen}...${source.sourceSha}`, {
        status: 'behind',
        base_commit: { sha: earlierGreen },
        merge_base_commit: { sha: source.sourceSha },
        files: [],
      });
      api.recordRange(source.sourceSha, earlierGreen, ['README.md']);
      expect(qualifyCanarySource(source, api).laneCoverage?.cargo.ranOnSource).toBe(false);
    });

    test('falls back to an older green run when the newest nominated commit has no evidence', () => {
      const api = new FakeQualificationApi();
      api.absent(43);
      api.absent(44);
      for (const workflow of ['cargo-shim.yml', 'protocol-ci.yml'] as const) {
        api.recordLaneNominations(workflow, [{ commit: otherCommit }, { commit: earlierGreen }]);
        api.recordWorkflowRun(workflow, otherCommit, { branch: 'attacker-branch' });
        api.recordWorkflowRun(workflow, earlierGreen);
      }
      api.recordRange(otherCommit, source.sourceSha, ['docs/a.md']);
      api.recordRange(earlierGreen, source.sourceSha, ['docs/b.md']);
      const receipt = qualifyCanarySource(source, api);
      expect(receipt.laneCoverage?.cargo.reason).toContain(earlierGreen);
      expect(receipt.laneCoverage?.cargo.reason).not.toContain(otherCommit);
    });

    describe('Protocol CI after a prose-only push, which runs no compiled job', () => {
      const compiledCommit = '1'.repeat(40);
      const proseCommit = '2'.repeat(40);
      const skippedMatrix = ['success', 'skipped', 'skipped', 'skipped'];
      const compiledChange = ['crates/mango-protocol/src/lib.rs', 'docs/protocol/README.md'];

      /** Cargo Shim covered by a green docs-only predecessor; Protocol CI is the variable. */
      function cargoCoveredApi() {
        const api = new FakeQualificationApi();
        api.recordLaneNominations('cargo-shim.yml', [{ commit: earlierGreen }]);
        api.recordWorkflowRun('cargo-shim.yml', earlierGreen);
        api.recordRange(earlierGreen, source.sourceSha, ['docs/guide.md']);
        return api;
      }
      /** The source edits only a prose guide: its Protocol CI run is green with the matrix skipped. */
      function proseOnlySourceApi() {
        const api = cargoCoveredApi();
        api.recordRange(source.pushBeforeSha as string, source.sourceSha, [
          'docs/protocol/README.md',
        ]);
        api.values.set('actions/runs/44/jobs?filter=all&per_page=100', [
          ...jobs(44, ['Protocol Gate']),
          ...jobs(44, ['TypeScript', 'cargo-deny', 'Schema equality and round trip']).map(
            (job) => ({ ...job, id: job.id + 10, conclusion: 'skipped' })
          ),
        ]);
        return api;
      }

      test('a compiled change, a prose-only push and an unrelated commit qualify', () => {
        // Protocol CI skipped C by path. B's run proves no compiled job; A's does, and the
        // prose guide B edited is not something the compiled matrix ever validated.
        const api = cargoCoveredApi();
        api.absent(44);
        api.recordLaneNominations('protocol-ci.yml', [
          { commit: proseCommit },
          { commit: compiledCommit },
        ]);
        api.recordWorkflowRun('protocol-ci.yml', proseCommit, { conclusions: skippedMatrix });
        api.recordWorkflowRun('protocol-ci.yml', compiledCommit);
        api.recordRange(proseCommit, source.sourceSha, ['docs/guide.md']);
        api.recordRange(compiledCommit, source.sourceSha, [
          'docs/protocol/README.md',
          'docs/guide.md',
        ]);
        const receipt = qualifyCanarySource(source, api);
        expect(receipt.laneCoverage?.protocol).toMatchObject({ ranOnSource: false });
        expect(receipt.laneCoverage?.protocol.reason).toContain(compiledCommit);
      });

      test('a prose-only source whose own run skipped the matrix needs a compiled predecessor', () => {
        const api = proseOnlySourceApi();
        api.recordLaneNominations('protocol-ci.yml', [{ commit: compiledCommit }]);
        api.recordWorkflowRun('protocol-ci.yml', compiledCommit);
        api.recordRange(compiledCommit, source.sourceSha, ['docs/protocol/README.md']);
        const receipt = qualifyCanarySource(source, api);
        expect(receipt.laneCoverage?.protocol).toMatchObject({ ranOnSource: false });
        expect(receipt.laneCoverage?.protocol.reason).toContain(compiledCommit);
        // The source's own Gate is still the sibling run the receipt names.
        expect(
          receipt.siblings.find((sibling) => sibling.workflow === 'protocol-ci.yml')
        ).toMatchObject({ result: 'success', runId: 44 });
      });

      test('a prose-only source after a compiled change whose run was cancelled is rejected', () => {
        // Its Gate is green, but the compiled change before it never passed Protocol CI on main.
        const api = proseOnlySourceApi();
        api.recordLaneNominations('protocol-ci.yml', [
          { commit: compiledCommit, conclusion: 'cancelled' },
          { commit: earlierGreen },
        ]);
        api.recordWorkflowRun('protocol-ci.yml', earlierGreen);
        api.recordRange(earlierGreen, source.sourceSha, compiledChange);
        expect(() => qualifyCanarySource(source, api)).toThrow(
          `protocol-ci.yml: expected a covering main run for ${source.sourceSha}; received no candidate covers ${source.sourceSha}: ${earlierGreen} (Protocol CI-relevant change)`
        );
      });

      test('a cancelled compiled change, a prose-only push and an unrelated commit are rejected', () => {
        const api = cargoCoveredApi();
        api.absent(44);
        api.recordLaneNominations('protocol-ci.yml', [
          { commit: proseCommit },
          { commit: earlierGreen },
        ]);
        api.recordWorkflowRun('protocol-ci.yml', proseCommit, { conclusions: skippedMatrix });
        api.recordWorkflowRun('protocol-ci.yml', earlierGreen);
        api.recordRange(proseCommit, source.sourceSha, ['docs/guide.md']);
        api.recordRange(earlierGreen, source.sourceSha, [...compiledChange, 'docs/guide.md']);
        expect(() => qualifyCanarySource(source, api)).toThrow(
          `${proseCommit} (no Actions evidence: Protocol Gate, TypeScript, cargo-deny and Schema equality and round trip did not all succeed`
        );
        expect(() => qualifyCanarySource(source, api)).toThrow(
          `${earlierGreen} (Protocol CI-relevant change)`
        );
      });

      test('a prose guide in the range is not a compiled change, but a spec file is', () => {
        const api = cargoCoveredApi();
        api.absent(44);
        api.recordLaneNominations('protocol-ci.yml', [{ commit: compiledCommit }]);
        api.recordWorkflowRun('protocol-ci.yml', compiledCommit);
        api.recordRange(compiledCommit, source.sourceSha, [
          'docs/protocol/versioning.md',
          'docs/protocol/adopt-rust.md',
        ]);
        expect(qualifyCanarySource(source, api).laneCoverage?.protocol.ranOnSource).toBe(false);
        api.recordRange(compiledCommit, source.sourceSha, [
          'docs/protocol/versioning.md',
          'spec/schema/1/protocol.json',
        ]);
        expect(() => qualifyCanarySource(source, api)).toThrow(
          `${compiledCommit} (Protocol CI-relevant change)`
        );
      });
    });

    describe('run listings are nominations, never the proof', () => {
      /** The listing names Z and the range Z...source is docs-only; Actions evidence is the variable. */
      function nominatedApi() {
        const api = new FakeQualificationApi();
        api.absent(43);
        api.absent(44);
        api.coverLanesFrom(earlierGreen);
        return api;
      }
      const missingEvidence = (reason: string) => `${earlierGreen} (no Actions evidence: ${reason}`;

      test('a nominated commit with no run for its SHA is rejected', () => {
        const api = nominatedApi();
        api.values.set(
          `actions/workflows/43/runs?branch=main&head_sha=${earlierGreen}&per_page=100`,
          []
        );
        expect(() => qualifyCanarySource(source, api)).toThrow(
          missingEvidence(
            `expected a completed cargo-shim.yml run on main for ${earlierGreen} (push or workflow_dispatch); received none`
          )
        );
      });

      test.each([
        ['a green run on another branch', { branch: 'attacker-branch' }],
        ['a green pull request run', { event: 'pull_request' }],
        ['a green scheduled run', { event: 'schedule' }],
      ])('rows plus %s are rejected', (_label, options) => {
        const api = nominatedApi();
        api.recordWorkflowRun('cargo-shim.yml', earlierGreen, options);
        expect(() => qualifyCanarySource(source, api)).toThrow(
          missingEvidence(`expected a completed cargo-shim.yml run on main for ${earlierGreen}`)
        );
      });

      test.each(['cargo-shim.yml', 'protocol-ci.yml'] as const)(
        'a manually dispatched green %s run on main is evidence',
        (workflow) => {
          // A dispatch runs every job of both lanes, and the jobs are still checked.
          const api = nominatedApi();
          api.recordWorkflowRun(workflow, earlierGreen, { event: 'workflow_dispatch' });
          expect(qualifyCanarySource(source, api).laneCoverage?.cargo.ranOnSource).toBe(false);
        }
      );

      test('rows plus a run from a workflow file with other bytes are rejected', () => {
        const api = nominatedApi();
        api.recordWorkflowRun('protocol-ci.yml', earlierGreen, {
          workflowBytes: 'name: Protocol CI\njobs: {}\n',
        });
        expect(() => qualifyCanarySource(source, api)).toThrow(
          missingEvidence(
            `.github/workflows/protocol-ci.yml at ${earlierGreen} differs from the qualification revision`
          )
        );
      });

      test.each(['failure', 'cancelled', 'skipped'])(
        'rows plus a run whose Cargo Shim Gate was %s are rejected',
        (conclusion) => {
          const api = nominatedApi();
          api.recordWorkflowRun('cargo-shim.yml', earlierGreen, { conclusions: [conclusion] });
          expect(() => qualifyCanarySource(source, api)).toThrow(
            missingEvidence(
              `Cargo Shim Gate did not succeed in a cargo-shim.yml run on main for ${earlierGreen}; received run`
            )
          );
        }
      );

      test('a Protocol Gate that went green over a skipped compiled matrix is not evidence', () => {
        const api = nominatedApi();
        api.recordWorkflowRun('protocol-ci.yml', earlierGreen, {
          conclusions: ['success', 'skipped', 'skipped', 'skipped'],
        });
        expect(() => qualifyCanarySource(source, api)).toThrow(
          missingEvidence(
            `Protocol Gate, TypeScript, cargo-deny and Schema equality and round trip did not all succeed in a protocol-ci.yml run on main for ${earlierGreen}; received run`
          )
        );
      });
    });

    describe('every doubt about the range or the lookup fails closed', () => {
      test('a nomination row that did not succeed is ignored', () => {
        const api = new FakeQualificationApi();
        api.absent(43);
        api.absent(44);
        api.recordLaneNominations('cargo-shim.yml', [
          { commit: earlierGreen, conclusion: 'cancelled' },
        ]);
        expect(() => qualifyCanarySource(source, api)).toThrow(
          'cargo-shim.yml: expected a covering main run for'
        );
        expect(() => qualifyCanarySource(source, api)).toThrow(
          'received no main commit has a successful Cargo Shim run'
        );
      });

      test.each(['push', 'workflow_dispatch'] as const)(
        'a failed %s nomination lookup rejects even when the other page covers the source',
        (event) => {
          const api = new FakeQualificationApi();
          api.absent(43);
          api.absent(44);
          api.coverLanesFrom(earlierGreen);
          api.failures.set(nominationPath(43, event), 'fixture denied API read');
          expect(() => qualifyCanarySource(source, api)).toThrow('fixture denied API read');
        }
      );

      test.each(['push', 'workflow_dispatch'] as const)(
        'a malformed %s nomination page is rejected, naming the value',
        (event) => {
          const api = new FakeQualificationApi();
          api.absent(43);
          api.absent(44);
          api.coverLanesFrom(earlierGreen);
          api.values.set(nominationPath(43, event), { workflow_runs: 'not-an-array' });
          expect(() => qualifyCanarySource(source, api)).toThrow(
            'expected a workflow_runs array; received {"workflow_runs":"not-an-array"}'
          );
        }
      );

      test('the covering run on the dispatch page counts when the push page is full of older runs', () => {
        // Without an event filter one page also holds pull request runs from a fork's main
        // branch, so each event is listed on its own and the two are merged by run number.
        const api = new FakeQualificationApi();
        api.absent(43);
        api.absent(44);
        for (const workflow of ['cargo-shim.yml', 'protocol-ci.yml'] as const) {
          api.recordFullPushPageOfOlderRuns(workflow, earlierGreen);
          api.recordWorkflowRun(workflow, earlierGreen, { event: 'workflow_dispatch' });
        }
        api.recordRange(earlierGreen, source.sourceSha, ['docs/guide.md']);
        const receipt = qualifyCanarySource(source, api);
        expect(receipt.laneCoverage?.cargo.reason).toContain(earlierGreen);
        expect(receipt.laneCoverage?.protocol.reason).toContain(earlierGreen);
      });

      test('a row from the wrong event or a fork-style pull request run nominates nothing', () => {
        const api = new FakeQualificationApi();
        api.absent(43);
        api.absent(44);
        api.recordLaneNominations('cargo-shim.yml', []);
        // The fake answers the push page with a pull request run on a fork's main branch.
        api.values.set(nominationPath(43, 'push'), {
          workflow_runs: [
            run(9100, 'cargo-shim.yml', 43, {
              event: 'pull_request',
              head_sha: earlierGreen,
              run_number: 900,
            }),
          ],
        });
        expect(() => qualifyCanarySource(source, api)).toThrow(
          'received no main commit has a successful Cargo Shim run'
        );
      });

      test('a failed compare propagates instead of assuming coverage', () => {
        const api = new FakeQualificationApi();
        api.absent(43);
        api.absent(44);
        api.coverLanesFrom(earlierGreen);
        api.failures.set(`compare/${earlierGreen}...${source.sourceSha}`, 'fixture denied compare');
        expect(() => qualifyCanarySource(source, api)).toThrow('fixture denied compare');
      });

      test.each([
        ['truncated', { truncated: true }],
        ['300 files', { files: Array.from({ length: 300 }, () => ({ filename: 'docs/a.md' })) }],
        ['diverged', { status: 'diverged' }],
        ['a merge base other than the candidate', { merge_base_commit: { sha: 'c'.repeat(40) } }],
      ])('an unproven range (%s) is not coverage', (_label, patch) => {
        const api = new FakeQualificationApi();
        api.absent(43);
        api.absent(44);
        api.coverLanesFrom(earlierGreen);
        const files = [{ filename: 'docs/guide.md', status: 'modified' }];
        const complete = {
          status: 'ahead',
          base_commit: { sha: earlierGreen },
          merge_base_commit: { sha: earlierGreen },
          files,
        };
        api.values.set(`compare/${earlierGreen}...${source.sourceSha}`, { ...complete, ...patch });
        // The reverse direction is unproven too, so neither order covers the source.
        api.values.set(`compare/${source.sourceSha}...${earlierGreen}`, {
          status: 'diverged',
        });
        expect(() => qualifyCanarySource(source, api)).toThrow(
          `${earlierGreen} (difference unproven)`
        );
      });

      test('a file renamed from a Cargo Shim path to a docs path is relevant', () => {
        const api = new FakeQualificationApi();
        api.absent(43);
        api.absent(44);
        api.coverLanesFrom(earlierGreen);
        api.values.set(`compare/${earlierGreen}...${source.sourceSha}`, {
          status: 'ahead',
          base_commit: { sha: earlierGreen },
          merge_base_commit: { sha: earlierGreen },
          files: [
            {
              filename: 'docs/moved.md',
              status: 'renamed',
              previous_filename: 'crates/x/src/lib.rs',
            },
          ],
        });
        expect(() => qualifyCanarySource(source, api)).toThrow(
          `${earlierGreen} (Cargo Shim-relevant change)`
        );
      });

      test('a file renamed from a protocol path to a docs path is relevant to Protocol CI only', () => {
        const api = protocolOnlyApi();
        api.values.set(`compare/${otherCommit}...${source.sourceSha}`, {
          status: 'ahead',
          base_commit: { sha: otherCommit },
          merge_base_commit: { sha: otherCommit },
          files: [
            {
              filename: 'notes/moved.txt',
              status: 'renamed',
              previous_filename: 'spec/schema/1/protocol.json',
            },
          ],
        });
        expect(() => qualifyCanarySource(source, api)).toThrow(
          `protocol-ci.yml: expected a covering main run for ${source.sourceSha}; received no candidate covers ${source.sourceSha}: ${otherCommit} (Protocol CI-relevant change)`
        );
      });

      test('a renamed entry without previous_filename is unproven, not irrelevant', () => {
        const api = new FakeQualificationApi();
        api.absent(43);
        api.absent(44);
        api.coverLanesFrom(earlierGreen);
        api.values.set(`compare/${earlierGreen}...${source.sourceSha}`, {
          status: 'ahead',
          base_commit: { sha: earlierGreen },
          merge_base_commit: { sha: earlierGreen },
          files: [{ filename: 'docs/moved.md', status: 'renamed' }],
        });
        api.values.set(`compare/${source.sourceSha}...${earlierGreen}`, { status: 'diverged' });
        expect(() => qualifyCanarySource(source, api)).toThrow(
          `${earlierGreen} (difference unproven)`
        );
      });
    });
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
      api.recordCandidateRun(analyzed);
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
      api.recordCandidateRun(later, { event: 'schedule' });
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

    describe('code scanning rows are nominations, never the proof', () => {
      /** Rows say X is analyzed and the range to the source is docs-only; Actions evidence is the variable. */
      function nominatedApi() {
        const api = skippedApi();
        api.recordRustAnalyses([{ commit: analyzed }]);
        api.recordRange(analyzed, source.sourceSha, ['docs/guide.md']);
        return api;
      }
      const missingEvidence = (reason: string) => `${analyzed} (no Actions evidence: ${reason}`;

      test('forged rows without any codeql.yml run for the candidate are rejected', () => {
        // An uploader can post an empty SARIF for X under refs/heads/main; X's Rust code never ran.
        const api = nominatedApi();
        api.values.set(`contents/.github/workflows/codeql.yml?ref=${analyzed}`, {
          encoding: 'base64',
          content: readFileSync('.github/workflows/codeql.yml').toString('base64'),
        });
        api.values.set(
          `actions/workflows/45/runs?branch=main&head_sha=${analyzed}&per_page=100`,
          []
        );
        expect(() => qualifyCanarySource(source, api)).toThrow(
          missingEvidence(
            `expected a completed codeql.yml run on main for ${analyzed} (push, schedule or workflow_dispatch); received none`
          )
        );
      });

      test.each(['failure', 'cancelled', 'skipped'])(
        'rows plus a run whose Rust job was %s are rejected',
        (conclusion) => {
          const api = nominatedApi();
          api.recordCandidateRun(analyzed, { windowsConclusion: conclusion });
          expect(() => qualifyCanarySource(source, api)).toThrow(
            `${analyzed} (no Actions evidence: Analyze (rust) and Analyze (rust, windows) did not both succeed in a codeql.yml run on main for ${analyzed}; received run`
          );
        }
      );

      test('rows plus a Linux-only success are rejected', () => {
        const api = nominatedApi();
        api.recordCandidateRun(analyzed, { windowsConclusion: 'cancelled' });
        expect(() => qualifyCanarySource(source, api)).toThrow('Analyze (rust, windows)');
      });

      test('rows plus a green run on a non-main branch are rejected', () => {
        const api = nominatedApi();
        api.recordCandidateRun(analyzed, { branch: 'attacker-branch' });
        expect(() => qualifyCanarySource(source, api)).toThrow(
          missingEvidence(`expected a completed codeql.yml run on main for ${analyzed}`)
        );
      });

      test('rows plus a green pull request run are rejected', () => {
        const api = nominatedApi();
        api.recordCandidateRun(analyzed, { event: 'pull_request' });
        expect(() => qualifyCanarySource(source, api)).toThrow(
          missingEvidence(`expected a completed codeql.yml run on main for ${analyzed}`)
        );
      });

      test('rows plus a green run from a workflow file with other bytes are rejected', () => {
        const api = nominatedApi();
        api.recordCandidateRun(analyzed, { workflowBytes: 'name: CodeQL\njobs: {}\n' });
        expect(() => qualifyCanarySource(source, api)).toThrow(
          missingEvidence(
            `.github/workflows/codeql.yml at ${analyzed} differs from the qualification revision`
          )
        );
      });

      test('a manually dispatched green run on main is evidence', () => {
        const api = nominatedApi();
        api.recordCandidateRun(analyzed, { event: 'workflow_dispatch' });
        expect(qualifyCanarySource(source, api).codeqlRust?.analyzed).toBe(false);
      });

      test('a forged newest candidate falls back to a genuinely evidenced older one', () => {
        const forged = 'c'.repeat(40);
        const api = skippedApi();
        api.recordRustAnalyses([{ commit: forged }, { commit: analyzed }]);
        api.recordCandidateRun(analyzed);
        api.values.set(`contents/.github/workflows/codeql.yml?ref=${forged}`, {
          encoding: 'base64',
          content: readFileSync('.github/workflows/codeql.yml').toString('base64'),
        });
        api.values.set(`actions/workflows/45/runs?branch=main&head_sha=${forged}&per_page=100`, []);
        api.recordRange(forged, source.sourceSha, ['docs/a.md']);
        api.recordRange(analyzed, source.sourceSha, ['docs/b.md']);
        const receipt = qualifyCanarySource(source, api);
        expect(receipt.codeqlRust?.reason).toContain(analyzed);
        expect(receipt.codeqlRust?.reason).not.toContain(forged);
      });
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

    test('a file renamed from a Rust-relevant path to a non-Rust path is Rust-relevant', () => {
      // The new name is docs, but the old side removed Rust source: both sides count.
      const api = skippedApi();
      api.recordRustAnalyses([{ commit: analyzed }]);
      api.recordCandidateRun(analyzed);
      api.values.set(`compare/${analyzed}...${source.sourceSha}`, {
        status: 'ahead',
        base_commit: { sha: analyzed },
        merge_base_commit: { sha: analyzed },
        files: [
          {
            filename: 'docs/old-runtime.md',
            status: 'renamed',
            previous_filename: 'crates/mangostudio-runtime/src/lib.rs',
          },
        ],
      });
      expect(() => qualifyCanarySource(source, api)).toThrow(`${analyzed} (Rust-relevant change)`);
    });

    test('a renamed entry without previous_filename is unproven, not irrelevant', () => {
      const api = skippedApi();
      api.recordRustAnalyses([{ commit: analyzed }]);
      api.recordCandidateRun(analyzed);
      api.values.set(`compare/${analyzed}...${source.sourceSha}`, {
        status: 'ahead',
        base_commit: { sha: analyzed },
        merge_base_commit: { sha: analyzed },
        files: [{ filename: 'docs/old-runtime.md', status: 'renamed' }],
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
  test('the runtime build workflow is a pinned producer contract, because the reuse rule reads its steps', () => {
    const api = new FakeQualificationApi();
    api.values.set(`contents/.github/workflows/runtime-build.yml?ref=${source.sourceSha}`, {
      encoding: 'base64',
      content: Buffer.from('name: Runtime Build\njobs: {}\n').toString('base64'),
    });
    expect(() => qualifyCanarySource(source, api)).toThrow(
      'runtime-build.yml: source validation contract differs from qualification revision'
    );
  });
  describe('runtime reuse', () => {
    const PRODUCER_SHA = 'd'.repeat(40);
    const DIGEST = 'c'.repeat(64);
    const BINARY_SHA = 'e'.repeat(64);
    const PLATFORM = 'linux-x64';

    /** The source run's `linux-x64` runtime job reused a base that run 700 built. */
    function reuseLinux(api: FakeQualificationApi) {
      const reusing = jobs(100, runNames).map((job) =>
        job.name === runtimeBuildJobName(PLATFORM)
          ? {
              ...job,
              steps: [
                { name: 'Use reused runtime base', conclusion: 'success' },
                { name: 'Build runtime', conclusion: 'success' },
              ],
            }
          : job
      );
      api.values.set('actions/runs/100/jobs?filter=all&per_page=100', reusing);
      api.values.set('actions/runs/100/artifacts?per_page=100', [
        {
          id: 77,
          name: runtimeReuseArtifactName(PLATFORM, 700, DIGEST, BINARY_SHA),
          expired: false,
          created_at: '2026-11-28T09:05:00Z',
          workflow_run: { id: 100 },
        },
      ]);
      api.values.set('actions/runs/700', {
        ...run(700, 'ci.yml', 42),
        head_sha: PRODUCER_SHA,
        run_attempt: 1,
        head_repository: { full_name: source.repository },
      });
      api.values.set('actions/runs/700/jobs?filter=all&per_page=100', [
        {
          ...jobs(700, [runtimeBuildJobName(PLATFORM)])[0],
          started_at: '2026-11-20T09:00:00Z',
          completed_at: '2026-11-20T09:10:00Z',
        },
      ]);
      api.values.set(`compare/${PRODUCER_SHA}...${source.sourceSha}`, {
        status: 'ahead',
        base_commit: { sha: PRODUCER_SHA },
        merge_base_commit: { sha: PRODUCER_SHA },
        files: [{ filename: 'README.md' }],
      });
    }

    test('a run that compiled every runtime records them as built', () => {
      const result = qualifyCanarySource(source, new FakeQualificationApi());
      expect(result.runtimeReuse).toEqual({
        reused: [],
        built: ALL_BINARY_TARGETS.map((target) => target.arch),
      });
    });

    test('a verified reuse is explained in the receipt', () => {
      const api = new FakeQualificationApi();
      reuseLinux(api);
      expect(qualifyCanarySource(source, api).runtimeReuse).toEqual({
        reused: [
          {
            platform: PLATFORM,
            digest: DIGEST,
            binarySha256: BINARY_SHA,
            producerRunId: 700,
            producerSha: PRODUCER_SHA,
            recordArtifactId: 77,
          },
        ],
        built: ALL_BINARY_TARGETS.map((target) => target.arch).filter(
          (platform) => platform !== PLATFORM
        ),
      });
    });

    test('a reuse whose record is missing rejects the source', () => {
      const api = new FakeQualificationApi();
      reuseLinux(api);
      api.values.set('actions/runs/100/artifacts?per_page=100', []);
      expect(() => qualifyCanarySource(source, api)).toThrow(
        'reuse records of run 100: expected exactly one, because the job reused a base'
      );
    });

    test('a reuse whose producer is not a main push of this repository rejects the source', () => {
      const api = new FakeQualificationApi();
      reuseLinux(api);
      api.values.set('actions/runs/700', {
        ...run(700, 'ci.yml', 42),
        head_sha: PRODUCER_SHA,
        run_attempt: 1,
        event: 'pull_request',
      });
      expect(() => qualifyCanarySource(source, api)).toThrow(
        'producer run 700 event: expected push'
      );
    });

    test('a source run without a runtime build job cannot be explained and is rejected', () => {
      const api = new FakeQualificationApi();
      api.values.set(
        'actions/runs/100/jobs?filter=all&per_page=100',
        jobs(100, runNames).filter((job) => job.name !== runtimeBuildJobName(PLATFORM))
      );
      expect(() => qualifyCanarySource(source, api)).toThrow(
        `${runtimeBuildJobName(PLATFORM)}: expected exactly one latest runtime build job through attempt 2; received []`
      );
    });

    test('a failed runtime build job rejects the source before any reuse is read', () => {
      const api = new FakeQualificationApi();
      api.values.set(
        'actions/runs/100/jobs?filter=all&per_page=100',
        jobs(100, runNames).map((job) =>
          job.name === runtimeBuildJobName(PLATFORM) ? { ...job, conclusion: 'failure' } : job
        )
      );
      expect(() => qualifyCanarySource(source, api)).toThrow(
        'expected completed successful associated job'
      );
    });
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
        jobs(100, runNames).map((job) => (job.name === ciNames[2] ? { ...job, conclusion } : job))
      );
      expect(() => qualifyCanarySource(source, api)).toThrow(
        'expected completed successful associated job'
      );
    });
  }
  test('an older successful job cannot hide a failed rerun job', () => {
    const api = new FakeQualificationApi();
    api.values.set('actions/runs/100/jobs?filter=all&per_page=100', [
      ...jobs(100, runNames),
      { ...jobs(100, runNames)[2], run_attempt: 2, conclusion: 'failure' },
    ]);
    expect(() => qualifyCanarySource(source, api)).toThrow(
      'expected completed successful associated job'
    );
  });
  test('rebuilding the distribution invalidates older smoke qualification', () => {
    const api = new FakeQualificationApi();
    api.values.set(
      'actions/runs/100/jobs?filter=all&per_page=100',
      jobs(100, runNames).map((job) =>
        job.name === ciNames[1] || job.name === 'CI Gate' ? { ...job, run_attempt: 2 } : job
      )
    );
    expect(() => qualifyCanarySource(source, api)).toThrow(
      'predates distribution builder attempt 2'
    );
  });
  test('missing and ambiguous mandatory jobs cannot be interpreted as successful skips', () => {
    const api = new FakeQualificationApi();
    api.values.set('actions/runs/100/jobs?filter=all&per_page=100', jobs(100, runNames).slice(1));
    expect(() => qualifyCanarySource(source, api)).toThrow('CI Gate: expected exactly one');
    api.values.set('actions/runs/100/jobs?filter=all&per_page=100', [
      ...jobs(100, runNames),
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
    [path.includes('/jobs?') ? 'jobs' : path.includes('/artifacts?') ? 'artifacts' : 'workflow_runs']: value,
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
  api.coverLanesFrom(earlierGreen);
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
  const previous = jobs(100, runNames);
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

describe('qualifyCanarySourceToFiles over the shared retry client', () => {
  const BASE = 'repos/owner/repo/';
  const BAD_GATEWAY = 'gh: Bad Gateway (HTTP 502)';
  const workflowRead = (name: string) => [
    'api',
    `${BASE}contents/.github/workflows/${name}?ref=${source.sourceSha}`,
  ];

  function setup() {
    const directory = mkdtempSync(join(tmpdir(), 'fix-canary-qualify-retry-'));
    const files = {
      receiptPath: join(directory, 'receipt.json'),
      githubOutputPath: join(directory, 'out'),
    };
    const environment = new RecordedRetryEnvironment();
    const runner = new ScriptedGhRunner(
      ghServing(new FakeQualificationApi().values, {
        prefix: BASE,
        collectionKey: (path) =>
          path.includes('/jobs?')
            ? 'jobs'
            : path.includes('/artifacts?')
              ? 'artifacts'
              : 'workflow_runs',
      })
    );
    const api = createCanaryGhApi(runner, new GitHubRetry(STANDARD_RETRY_POLICY, environment));
    return { directory, files, environment, runner, api };
  }

  test('a 502 on the first read is retried and the receipt and outputs are written', () => {
    const { directory, files, environment, runner, api } = setup();
    try {
      runner.script(workflowRead('ci.yml'), ghFailure(BAD_GATEWAY));
      const receipt = qualifyCanarySourceToFiles(source, files, api);
      expect(receipt).toEqual(qualifyCanarySource(source, new FakeQualificationApi()));
      expect(JSON.parse(readFileSync(files.receiptPath, 'utf8')).source).toEqual(source);
      expect(readFileSync(files.githubOutputPath, 'utf8')).toBe(
        'builder_attempt=1\nqualified=true\n'
      );
      expect(runner.callsOf(workflowRead('ci.yml'))).toBe(2);
      expect(environment.waits).toEqual([5_000]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a persistent 502 on the CI jobs listing names the request and writes nothing', () => {
    const { directory, files, environment, runner, api } = setup();
    try {
      const jobsRead = [
        'api',
        '--paginate',
        '--slurp',
        `${BASE}actions/runs/100/jobs?filter=all&per_page=100`,
      ];
      runner.always(jobsRead, ghFailure(BAD_GATEWAY));
      expect(() => qualifyCanarySourceToFiles(source, files, api)).toThrow(
        `GitHub API GET ${BASE}actions/runs/100/jobs?filter=all&per_page=100 (all pages): expected successful gh exit 0 | received: exit 1 | stderr: ${BAD_GATEWAY}`
      );
      expect(runner.callsOf(jobsRead)).toBe(3);
      expect(environment.waits).toEqual([5_000, 10_000]);
      expect(existsSync(files.receiptPath)).toBe(false);
      expect(existsSync(files.githubOutputPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a 404 is not retried', () => {
    const { directory, files, environment, runner, api } = setup();
    try {
      runner.always(workflowRead('ci.yml'), ghFailure('gh: Not Found (HTTP 404)'));
      expect(() => qualifyCanarySourceToFiles(source, files, api)).toThrow(
        'expected successful gh exit 0 | received: exit 1 | stderr: gh: Not Found (HTTP 404)'
      );
      expect(runner.calls).toHaveLength(1);
      expect(environment.waits).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('the dozens of reads share one 60 s wait budget instead of 60 s each', () => {
    const { directory, files, environment, runner, api } = setup();
    try {
      const names = ['ci.yml', 'distribution-build.yml', 'smoke-binary.yml', 'smoke-container.yml'];
      // Four reads each fail twice and then succeed: 4 * (5 s + 10 s) spends the budget.
      for (const name of names) {
        runner.script(workflowRead(name), ghFailure(BAD_GATEWAY), ghFailure(BAD_GATEWAY));
      }
      // The fifth read finds no wait left, so its first 502 is final.
      runner.always(workflowRead('cargo-shim.yml'), ghFailure(BAD_GATEWAY));
      expect(() => qualifyCanarySourceToFiles(source, files, api)).toThrow(
        `GitHub API GET ${BASE}contents/.github/workflows/cargo-shim.yml?ref=${source.sourceSha}: expected successful gh exit 0`
      );
      expect(environment.waits).toEqual([
        5_000, 10_000, 5_000, 10_000, 5_000, 10_000, 5_000, 10_000,
      ]);
      expect(runner.callsOf(workflowRead('cargo-shim.yml'))).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
