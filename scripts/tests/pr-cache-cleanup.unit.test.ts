import { describe, expect, test } from 'bun:test';

import type { ActionsCacheEntry } from '../ci/actions-api/client';
import { parsePullRequestCacheArguments } from '../ci/pr-cache-cleanup';
import {
  cleanupPullRequestCaches,
  formatPullRequestCacheReport,
  sweepClosedPullRequestCaches,
} from '../ci/pr-cache/cleanup';
import { GithubPullRequestCacheApi, type PullRequestCacheApi } from '../ci/pr-cache/github';
import {
  parsePullRequestNumber,
  pullRequestMergeRef,
  pullRequestNumberOfRef,
  pullRequestNumbers,
  type PullRequestState,
  selectClosedPullRequestCaches,
  selectPullRequestCaches,
} from '../ci/pr-cache/selection';
import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractJobBlocks,
  extractStepBlocks,
  runScriptLines,
} from './support/workflow-blocks';

const REPOSITORY = 'owner/repo';
const WORKFLOW = '.github/workflows/pr-cache-cleanup.yml';
// Split so this file's own text cannot satisfy the interpolation scan below.
const EXPRESSION_OPEN = '$' + '{{';

function cache(id: number, ref: string, size = 1000): ActionsCacheEntry {
  return {
    id,
    key: `Linux-X64-turbo-pr-7-test-${id}`,
    ref,
    version: 'v',
    created_at: '2026-11-01T00:00:00Z',
    size_in_bytes: size,
  };
}

const MIXED_LISTING = [
  cache(1, 'refs/pull/7/merge', 100),
  cache(2, 'refs/pull/7/merge', 200),
  cache(3, 'refs/pull/70/merge', 300),
  cache(4, 'refs/pull/7/head', 400),
  cache(5, 'refs/heads/main', 500),
  cache(6, 'refs/pull/7/merge/extra', 600),
  cache(7, 'refs/pull/8/merge', 700),
  cache(8, 'refs/pull/9/merge', 800),
];

class FakePullRequestCacheApi implements PullRequestCacheApi {
  entries: ActionsCacheEntry[] = [...MIXED_LISTING];
  states = new Map<number, PullRequestState>();
  deletedIds: number[] = [];
  goneIds = new Set<number>();
  failDeleteOf: number | undefined;
  // A listing that ignores the `ref` filter: selection must still be exact.
  ignoreRefFilter = false;
  refsListed: string[] = [];

  listCachesOnRef(ref: string): Promise<ActionsCacheEntry[]> {
    this.refsListed.push(ref);
    return Promise.resolve(
      this.ignoreRefFilter ? this.entries : this.entries.filter((entry) => entry.ref === ref)
    );
  }

  listAllCaches(): Promise<ActionsCacheEntry[]> {
    return Promise.resolve(this.entries);
  }

  pullRequestState(pullRequest: number): Promise<PullRequestState | undefined> {
    return Promise.resolve(this.states.get(pullRequest));
  }

  deleteCache(id: number): Promise<boolean> {
    if (id === this.failDeleteOf) return Promise.reject(new Error('DELETE returned 403'));
    if (this.goneIds.has(id)) return Promise.resolve(false);
    this.deletedIds.push(id);
    return Promise.resolve(true);
  }
}

describe('pull request number', () => {
  test('accepts a positive decimal integer', () => {
    expect(parsePullRequestNumber('1')).toBe(1);
    expect(parsePullRequestNumber('2222')).toBe(2222);
  });

  test.each([
    '',
    '0',
    '-1',
    '+5',
    '01',
    '1.5',
    '1e3',
    '12abc',
    ' 7',
    '7 ',
    '5/../x',
    '99999999999999999999',
  ])('refuses %j and names it with the expected shape', (value) => {
    expect(() => parsePullRequestNumber(value)).toThrow(
      `Invalid pull request number ${JSON.stringify(value)}; expected a positive integer`
    );
  });

  test('builds only the merge ref of a valid number', () => {
    expect(pullRequestMergeRef(7)).toBe('refs/pull/7/merge');
    expect(() => pullRequestMergeRef(0)).toThrow('expected a positive integer');
    expect(() => pullRequestMergeRef(1.5)).toThrow('expected a positive integer');
  });

  test('reads a number back only from an exact merge ref', () => {
    expect(pullRequestNumberOfRef('refs/pull/7/merge')).toBe(7);
    for (const ref of [
      'refs/pull/7/head',
      'refs/pull/07/merge',
      'refs/pull/7/merge/x',
      'xrefs/pull/7/merge',
      'refs/heads/main',
    ]) {
      expect(pullRequestNumberOfRef(ref), ref).toBeUndefined();
    }
  });
});

describe('selection', () => {
  test('selects the exact merge ref of one pull request and nothing else', () => {
    const ids = selectPullRequestCaches(MIXED_LISTING, 7).map((entry) => entry.id);
    expect(ids, `expected IDs saved on refs/pull/7/merge | received: [${ids}]`).toEqual([1, 2]);
  });

  test('lists the distinct merge-ref pull requests in ascending order', () => {
    expect(pullRequestNumbers(MIXED_LISTING)).toEqual([7, 8, 9, 70]);
  });

  test('selects only the merge refs of closed pull requests', () => {
    const states = new Map<number, PullRequestState>([
      [7, 'closed'],
      [8, 'open'],
      [70, 'closed'],
    ]);
    const ids = selectClosedPullRequestCaches(MIXED_LISTING, states).map((entry) => entry.id);
    // 8 is open, 9 has no known state, refs/pull/7/head and main are not merge refs.
    expect(ids).toEqual([1, 2, 3]);
  });
});

describe('single pull request cleanup', () => {
  test('deletes the pull request merge-ref caches and reports bytes', async () => {
    const api = new FakePullRequestCacheApi();
    const result = await cleanupPullRequestCaches(api, 7, { apply: true });
    expect(api.refsListed).toEqual(['refs/pull/7/merge']);
    expect(api.deletedIds).toEqual([1, 2]);
    expect(result.deletedIds).toEqual([1, 2]);
    expect(formatPullRequestCacheReport(result)).toContain('Deleted: 2 caches, 300 bytes');
  });

  test('never touches another ref even when the listing ignores the ref filter', async () => {
    const api = new FakePullRequestCacheApi();
    api.ignoreRefFilter = true;
    await cleanupPullRequestCaches(api, 7, { apply: true });
    expect(api.deletedIds).toEqual([1, 2]);
  });

  test('deletes nothing in a dry run and still reports the plan', async () => {
    const api = new FakePullRequestCacheApi();
    const result = await cleanupPullRequestCaches(api, 7, { apply: false });
    expect(api.deletedIds).toEqual([]);
    expect(result.planned.map((entry) => entry.id)).toEqual([1, 2]);
    const report = formatPullRequestCacheReport(result);
    expect(report).toContain('dry run, nothing deleted');
    expect(report).toContain('Planned: 2 caches, 300 bytes across 1 pull requests');
    expect(report).not.toContain('Deleted:');
  });

  test('treats an already deleted cache as gone and continues', async () => {
    const api = new FakePullRequestCacheApi();
    api.goneIds.add(1);
    const result = await cleanupPullRequestCaches(api, 7, { apply: true });
    expect(result.alreadyGoneIds).toEqual([1]);
    expect(result.deletedIds).toEqual([2]);
    expect(formatPullRequestCacheReport(result)).toContain('Deleted: 1 caches, 200 bytes');
  });

  test('stops on a delete failure other than 404', async () => {
    const api = new FakePullRequestCacheApi();
    api.failDeleteOf = 1;
    await expect(cleanupPullRequestCaches(api, 7, { apply: true })).rejects.toThrow('403');
    expect(api.deletedIds).toEqual([]);
  });

  test('names the progress when a sweep fails midway, so a re-run can continue', async () => {
    const api = new FakePullRequestCacheApi();
    api.states = new Map<number, PullRequestState>([
      [7, 'closed'],
      [70, 'closed'],
    ]);
    api.failDeleteOf = 3;
    await expect(sweepClosedPullRequestCaches(api, { apply: true })).rejects.toThrow(
      'DELETE returned 403; deleted 2 of 3 caches (300 bytes) before stopping, re-run to continue'
    );
    expect(api.deletedIds).toEqual([1, 2]);
  });

  test('refuses an invalid number before listing anything', async () => {
    const api = new FakePullRequestCacheApi();
    await expect(cleanupPullRequestCaches(api, -2, { apply: true })).rejects.toThrow(
      'Invalid pull request number "-2"; expected a positive integer'
    );
    expect(api.refsListed).toEqual([]);
  });

  test('plans nothing for a pull request without caches', async () => {
    const api = new FakePullRequestCacheApi();
    const result = await cleanupPullRequestCaches(api, 12345, { apply: true });
    expect(result.planned).toEqual([]);
    expect(api.deletedIds).toEqual([]);
  });
});

describe('closed pull request sweep', () => {
  function sweepApi(): FakePullRequestCacheApi {
    const api = new FakePullRequestCacheApi();
    api.states = new Map<number, PullRequestState>([
      [7, 'closed'],
      [8, 'open'],
      [70, 'closed'],
    ]);
    return api;
  }

  test('deletes closed pull requests only and leaves open, unknown and non-merge refs', async () => {
    const api = sweepApi();
    const result = await sweepClosedPullRequestCaches(api, { apply: true });
    expect(api.deletedIds).toEqual([1, 2, 3]);
    expect(result.skipped).toEqual({ open: [8], unknown: [9] });
    expect(formatPullRequestCacheReport(result)).toContain(
      'Left alone: 1 open pull requests, 1 with an unknown state'
    );
  });

  test('deletes nothing in a dry run and plans the same set', async () => {
    const api = sweepApi();
    const result = await sweepClosedPullRequestCaches(api, { apply: false });
    expect(api.deletedIds).toEqual([]);
    expect(result.planned.map((entry) => entry.id)).toEqual([1, 2, 3]);
  });

  test('tolerates a cache that disappeared before its delete', async () => {
    const api = sweepApi();
    api.goneIds.add(3);
    const result = await sweepClosedPullRequestCaches(api, { apply: true });
    expect(api.deletedIds).toEqual([1, 2]);
    expect(result.alreadyGoneIds).toEqual([3]);
  });
});

describe('command line', () => {
  test('defaults to a dry run', () => {
    expect(parsePullRequestCacheArguments(['--pr', '2222'])).toEqual({
      kind: 'pull-request',
      pullRequest: 2222,
      apply: false,
    });
    expect(parsePullRequestCacheArguments(['--all-closed'])).toEqual({
      kind: 'all-closed',
      apply: false,
    });
  });

  test('applies only with --delete, in any position', () => {
    expect(parsePullRequestCacheArguments(['--delete', '--pr', '2222']).apply).toBe(true);
    expect(parsePullRequestCacheArguments(['--all-closed', '--delete']).apply).toBe(true);
  });

  test('names the received number when it is invalid', () => {
    expect(() => parsePullRequestCacheArguments(['--pr', '12abc'])).toThrow(
      'Invalid pull request number "12abc"; expected a positive integer'
    );
  });

  test.each([
    [[]],
    [['--pr']],
    [['--delete']],
    [['--pr', '1', '--all-closed']],
    [['--pr', '1', '2']],
  ])('refuses the argument shape %j', (args) => {
    expect(() => parsePullRequestCacheArguments(args)).toThrow('Invalid arguments');
  });
});

class FakeGithubHttp {
  replies: Array<{ status: number; body?: unknown }> = [];
  calls: Array<{ url: URL; init: RequestInit }> = [];

  request(url: string, init: RequestInit): Promise<Response> {
    this.calls.push({ url: new URL(url), init });
    const reply = this.replies.shift();
    if (!reply) throw new Error(`Unexpected fake GitHub request ${url}`);
    return Promise.resolve(
      new Response(reply.status === 204 ? null : JSON.stringify(reply.body), {
        status: reply.status,
      })
    );
  }

  api(): GithubPullRequestCacheApi {
    return new GithubPullRequestCacheApi(REPOSITORY, 'fake-token', this.request.bind(this));
  }
}

describe('GitHub adapter', () => {
  test('follows every page of one ref-scoped cache listing', async () => {
    const http = new FakeGithubHttp();
    const first = Array.from({ length: 100 }, (_, index) => cache(index + 1, 'refs/pull/7/merge'));
    http.replies = [
      { status: 200, body: { total_count: 101, actions_caches: first } },
      {
        status: 200,
        body: { total_count: 101, actions_caches: [cache(101, 'refs/pull/7/merge')] },
      },
    ];
    expect(await http.api().listCachesOnRef('refs/pull/7/merge')).toHaveLength(101);
    expect(http.calls.map(({ url }) => url.searchParams.get('page'))).toEqual(['1', '2']);
    for (const { url, init } of http.calls) {
      expect(url.pathname).toBe(`/repos/${REPOSITORY}/actions/caches`);
      expect(url.searchParams.get('ref')).toBe('refs/pull/7/merge');
      expect(init.method).toBe('GET');
    }
  });

  test('lists every cache without a ref filter for the sweep', async () => {
    const http = new FakeGithubHttp();
    http.replies = [
      { status: 200, body: { total_count: 1, actions_caches: [cache(1, 'refs/pull/7/merge')] } },
    ];
    await http.api().listAllCaches();
    expect(http.calls[0].url.searchParams.has('ref')).toBe(false);
  });

  test('rejects an incomplete listing instead of deleting from a partial one', async () => {
    const http = new FakeGithubHttp();
    const partial = {
      status: 200,
      body: { total_count: 2, actions_caches: [cache(1, 'refs/pull/7/merge')] },
    };
    http.replies = [partial, partial];
    await expect(cleanupPullRequestCaches(http.api(), 7, { apply: true })).rejects.toThrow(
      'Incomplete actions_caches listing 1/2'
    );
    expect(http.calls.map(({ init }) => init.method)).not.toContain('DELETE');
  });

  test('deletes by numeric ID, accepting 404 as already gone', async () => {
    const http = new FakeGithubHttp();
    http.replies = [{ status: 204 }, { status: 404 }, { status: 403 }];
    const api = http.api();
    expect(await api.deleteCache(5)).toBe(true);
    expect(await api.deleteCache(5)).toBe(false);
    await expect(api.deleteCache(5)).rejects.toThrow('returned 403');
    expect(http.calls.every(({ url }) => url.pathname.endsWith('/actions/caches/5'))).toBe(true);
    await expect(api.deleteCache(0)).rejects.toThrow('Invalid cache ID 0');
  });

  test('reads pull request state from the pulls endpoint', async () => {
    const http = new FakeGithubHttp();
    http.replies = [
      { status: 200, body: { state: 'closed' } },
      { status: 200, body: { state: 'open' } },
      { status: 404, body: { message: 'Not Found' } },
      { status: 200, body: { state: 'draft' } },
      { status: 500, body: {} },
    ];
    const api = http.api();
    expect(await api.pullRequestState(7)).toBe('closed');
    expect(await api.pullRequestState(8)).toBe('open');
    expect(await api.pullRequestState(9)).toBeUndefined();
    await expect(api.pullRequestState(10)).rejects.toThrow(
      'Invalid pull request 10 state "draft"; expected "open" or "closed"'
    );
    await expect(api.pullRequestState(11)).rejects.toThrow('returned 500');
    expect(http.calls[0].url.pathname).toBe(`/repos/${REPOSITORY}/pulls/7`);
    await expect(api.pullRequestState(0)).rejects.toThrow('expected a positive integer');
  });
});

describe('pr-cache-cleanup workflow policy', () => {
  const workflow = readText(WORKFLOW);
  // Whole-line comments explain the trigger and name refs; only code is scanned.
  const code = workflow
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const jobs = extractJobBlocks(workflow);
  const closedJob = extractJobBlock(workflow, 'closed-pull-request');

  test('runs on pull_request_target closed, not on pull_request', () => {
    expect(workflow).toMatch(/^ {2}pull_request_target:\n {4}types: \[closed\]$/m);
    expect(workflow).not.toMatch(/^ {2}pull_request:/m);
    expect(workflow).toContain('permissions: {}');
  });

  test('never checks out or runs pull request code', () => {
    expect(code).not.toMatch(/github\.event\.pull_request\.head/);
    expect(code).not.toMatch(/github\.head_ref|refs\/pull\/|github\.event\.workflow_run/);
    expect(code).not.toMatch(/\brepository:/);
    for (const { job, block } of jobs) {
      const steps = extractStepBlocks(block);
      const checkouts = steps.filter((step) => /uses:\s*actions\/checkout@/.test(step));
      expect(checkouts, `${job}: expected one checkout`).toHaveLength(1);
      expect(checkouts[0], job).toMatch(/^\s+ref: main$/m);
      expect(checkouts[0], job).toMatch(/^\s+persist-credentials: false$/m);
      // Only the trusted checkout, the repo's Bun composite and the script run.
      for (const step of steps) {
        const uses = /uses:\s*(\S+)/.exec(step)?.[1];
        if (uses)
          expect(uses, job).toMatch(
            /^(actions\/checkout@[0-9a-f]{40}|[.$]\/\.github\/actions\/setup-bun)$/
          );
      }
      expect(block, job).not.toMatch(/bun (install|run)\b|download-artifact|actions\/cache/);
    }
  });

  test('passes the pull request number through env and never interpolates a shell', () => {
    expect(closedJob).toMatch(
      new RegExp(
        `^ {10}PR_NUMBER: \\${EXPRESSION_OPEN} github\\.event\\.pull_request\\.number \\}\\}$`,
        'm'
      )
    );
    expect(closedJob).toContain('bun ./scripts/ci/pr-cache-cleanup.ts --pr "$PR_NUMBER" --delete');
    const scripts = runScriptLines(workflow);
    expect(scripts.length, 'expected run scripts in the workflow').toBeGreaterThan(0);
    for (const { line, text } of scripts)
      expect(text, `${WORKFLOW}:${line}`).not.toContain(EXPRESSION_OPEN);
  });

  test('grants least permissions, a timeout and a per-pull-request concurrency group', () => {
    expect(closedJob).toMatch(/^ {6}contents: read\b/m);
    expect(closedJob).toMatch(/^ {6}actions: write\b/m);
    expect(closedJob).not.toMatch(/(pull-requests|issues|packages|id-token|checks): write/);
    expect(closedJob).toMatch(/^ {4}timeout-minutes: \d+/m);
    expect(workflow).toContain(
      `group: pr-cache-cleanup-${EXPRESSION_OPEN} github.event.pull_request.number || 'backlog' }}`
    );
    expect(workflow).toContain('cancel-in-progress: false');
  });

  test('keeps the backlog sweep manual, on main and dry-run by default', () => {
    const backlog = extractJobBlock(workflow, 'closed-backlog');
    expect(workflow).toMatch(
      /^ {2}workflow_dispatch:\n {4}inputs:\n {6}delete:[\s\S]*?default: false/m
    );
    expect(backlog).toContain("github.event_name == 'workflow_dispatch'");
    expect(backlog).toContain("github.ref == 'refs/heads/main'");
    expect(backlog).toMatch(/^ {6}pull-requests: read\b/m);
    expect(backlog).toContain(`bun ./scripts/ci/pr-cache-cleanup.ts "${'$'}{args[@]}"`);
    expect(backlog).toContain('args=(--all-closed)');
  });
});
