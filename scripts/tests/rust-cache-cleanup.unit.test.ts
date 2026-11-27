import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCleanupContext, readFixtureListing } from '../ci/rust-cache-cleanup';
import { cleanupRustCaches } from '../ci/rust-cache/cleanup';
import {
  type CacheWriterRun,
  GithubRustCacheApi,
  isMainCacheWriter,
  type RustCacheApi,
} from '../ci/rust-cache/github';
import { type RustCacheEntry, selectRustCacheDeletions } from '../ci/rust-cache/selection';
import { ROOT_DIR } from '../lib/config';
import { GitHubRetry, STANDARD_RETRY_POLICY } from '../lib/github-retry';
import { readText } from './support/read-text';
import { RecordedRetryEnvironment, ScriptedGitHubHttp } from './support/scripted-github-http';

const listing = JSON.parse(readText('scripts/tests/fixtures/rust-cache-listing.json')) as {
  actions_caches: RustCacheEntry[];
};

test('deletes the two superseded generations in the captured full cache listing', () => {
  const oldEntries = listing.actions_caches.filter((entry) =>
    [8769523517, 8769581166].includes(entry.id)
  );
  const expected = oldEntries.map((entry) => entry.key).sort();
  const received = selectRustCacheDeletions(listing.actions_caches)
    .map(({ entry }) => entry.key)
    .sort();
  expect(
    received,
    `expected entries to delete: [${expected.join(', ')}] | received: [${received.join(', ')}]`
  ).toEqual(expected);
});

const OLD = listing.actions_caches.find((entry) => entry.id === 8769581166) as RustCacheEntry;
const NEW = listing.actions_caches.find((entry) => entry.id === 8778446235) as RustCacheEntry;
const REPOSITORY = 'juliopolycarpo/mangostudio';
const MAIN_RUN: CacheWriterRun = {
  id: 42,
  path: '.github/workflows/ci.yml',
  event: 'push',
  status: 'completed',
  head_branch: 'main',
  head_repository: { full_name: REPOSITORY },
};

function changedEntry(entry: RustCacheEntry, changes: Partial<RustCacheEntry>): RustCacheEntry {
  return { ...entry, ...changes };
}

function ids(entries: readonly RustCacheEntry[]): number[] {
  return selectRustCacheDeletions(entries).map(({ entry }) => entry.id);
}

describe('Rust cache generation selection', () => {
  test('keeps the committed replacement and deletes every older dependency generation', () => {
    const oldest = changedEntry(OLD, {
      id: 1,
      key: OLD.key.replace('f6a2f3f2', '12345678'),
      created_at: '2026-10-09T00:00:00Z',
    });
    const plan = selectRustCacheDeletions([NEW, OLD, oldest]);
    expect(plan.map(({ entry }) => entry.id)).toEqual([OLD.id, 1]);
    expect(plan.every(({ replacement }) => replacement.id === NEW.id)).toBe(true);
    expect(plan.map(({ entry }) => entry.id)).not.toContain(NEW.id);
  });

  test('retires a dead root-manifest prefix only inside the same explicit family', () => {
    const deadPrefix = changedEntry(OLD, { key: OLD.key.replace(/[a-f0-9]{64}/, 'f'.repeat(64)) });
    expect(ids([NEW, deadPrefix])).toEqual([OLD.id]);
  });

  test('requires a positive committed archive size and distinct immutable IDs', () => {
    expect(ids([OLD, changedEntry(NEW, { size_in_bytes: 0 })])).toEqual([]);
    expect(ids([OLD, changedEntry(NEW, { id: -1 })])).toEqual([]);
    expect(ids([OLD, changedEntry(NEW, { id: OLD.id })])).toEqual([]);
  });

  test('keeps sole entries, non-Rust families, excluded fuzz and unknown future families', () => {
    const fuzz = changedEntry(OLD, { id: 2, key: 'v0-rust-fuzz-Linux-x64-12345678-87654321' });
    const future = changedEntry(OLD, {
      id: 3,
      key: OLD.key.replace('runtime-build-linux-arm64', 'runtime-build-light-linux-arm64'),
    });
    const futureNew = changedEntry(future, {
      id: 4,
      key: future.key.replace('f6a2f3f2', 'abcdef01'),
      created_at: NEW.created_at,
    });
    const nonRust = listing.actions_caches.find(
      (entry) => !entry.key.startsWith('v0-rust-')
    ) as RustCacheEntry;
    expect(ids([NEW, fuzz, future, futureNew, nonRust])).toEqual([]);
  });

  test.each([
    { label: 'PR ref', change: { ref: 'refs/pull/99/merge' } },
    { label: 'branch ref', change: { ref: 'refs/heads/work' } },
    { label: 'archive version', change: { version: 'a'.repeat(64) } },
    { label: 'runner OS', change: { key: OLD.key.replace('-Linux-', '-Darwin-') } },
    {
      label: 'runner architecture',
      change: { key: OLD.key.replace('-Linux-x64-', '-Linux-arm64-') },
    },
    {
      label: 'target',
      change: { key: OLD.key.replace('runtime-build-linux-arm64', 'runtime-build-linux-x64') },
    },
    {
      label: 'musl target',
      change: {
        key: OLD.key.replace('runtime-build-linux-arm64', 'runtime-build-linux-arm64-musl'),
      },
    },
    {
      label: 'compiler/environment hash',
      change: { key: OLD.key.replace('b9e20461', 'a1b2c3d4') },
    },
    {
      label: 'shipping/light profile hash',
      change: { key: OLD.key.replace('b9e20461', '1234abcd') },
    },
    { label: 'unknown key grammar', change: { key: `${OLD.key}-extra` } },
    { label: 'missing archive version', change: { version: '' } },
  ])('keeps a different $label out of the replacement family', ({ change }) => {
    expect(ids([NEW, changedEntry(OLD, change)])).toEqual([]);
  });

  test('separates shipping and light profiles even with the same shared family key', () => {
    const lightOld = changedEntry(OLD, { id: 2, key: OLD.key.replace('b9e20461', '1234abcd') });
    const lightNew = changedEntry(NEW, { id: 3, key: NEW.key.replace('b9e20461', '1234abcd') });
    const plan = selectRustCacheDeletions([NEW, OLD, lightNew, lightOld]);
    expect(plan.map(({ entry, replacement }) => [entry.id, replacement.id])).toEqual([
      [OLD.id, NEW.id],
      [2, 3],
    ]);
  });

  test('keeps ambiguous timestamps, malformed timestamps and duplicate generations', () => {
    expect(ids([NEW, changedEntry(OLD, { created_at: NEW.created_at })])).toEqual([]);
    expect(ids([NEW, changedEntry(OLD, { created_at: 'not a timestamp' })])).toEqual([]);
    expect(ids([NEW, changedEntry(OLD, { key: NEW.key })])).toEqual([]);
  });
});

/** A retry runtime that records its waits instead of sleeping, for fakes that bypass HTTP. */
function inertRetry(): GitHubRetry {
  return new GitHubRetry(STANDARD_RETRY_POLICY, new RecordedRetryEnvironment());
}

class FakeRustCacheApi implements RustCacheApi {
  entries: RustCacheEntry[] = [OLD, NEW];
  snapshots: RustCacheEntry[][] = [];
  writers: CacheWriterRun[] = [];
  writerSnapshots: CacheWriterRun[][] = [];
  deletedIds: number[] = [];
  trigger = MAIN_RUN;
  deleteError: Error | undefined;
  dropReplacementAfterDelete = false;

  getRun(_id: number): Promise<CacheWriterRun> {
    return Promise.resolve(this.trigger);
  }
  listCaches(): Promise<RustCacheEntry[]> {
    return Promise.resolve(this.snapshots.shift() ?? [...this.entries]);
  }
  activeWriters(): Promise<CacheWriterRun[]> {
    return Promise.resolve(this.writerSnapshots.shift() ?? this.writers);
  }
  deleteCache(id: number): Promise<boolean> {
    if (this.deleteError) return Promise.reject(this.deleteError);
    this.deletedIds.push(id);
    this.entries = this.entries.filter(
      (entry) => entry.id !== id && !(this.dropReplacementAfterDelete && entry.id === NEW.id)
    );
    return Promise.resolve(true);
  }
}

describe('post-save cleanup', () => {
  test('deletes exact old IDs only and retains replacements', async () => {
    const api = new FakeRustCacheApi();
    const result = await cleanupRustCaches(api, {
      repository: REPOSITORY,
      runId: 42,
      apply: true,
      retry: inertRetry(),
    });
    expect(result.deletedIds).toEqual([OLD.id]);
    expect(api.entries).toEqual([NEW]);
    expect(result.deferred).toBeNull();
  });

  test('dry runs produce a plan without mutations', async () => {
    const api = new FakeRustCacheApi();
    const result = await cleanupRustCaches(api, {
      repository: REPOSITORY,
      runId: 42,
      apply: false,
      retry: inertRetry(),
    });
    expect(result.planned).toHaveLength(1);
    expect(api.deletedIds).toEqual([]);
  });

  test('defers when a main writer is saving', async () => {
    const api = new FakeRustCacheApi();
    api.writers = [{ ...MAIN_RUN, id: 43, status: 'in_progress' }];
    const result = await cleanupRustCaches(api, {
      repository: REPOSITORY,
      runId: 42,
      apply: true,
      retry: inertRetry(),
    });
    expect(result.deferred).toContain('43');
    expect(api.deletedIds).toEqual([]);
  });

  test('defers when a simultaneous save changes the newest generation', async () => {
    const api = new FakeRustCacheApi();
    const newer = changedEntry(NEW, {
      id: 3,
      key: NEW.key.replace('d21022ad', 'abcdef01'),
      created_at: '2026-10-11T00:00:00Z',
    });
    api.snapshots = [
      [OLD, NEW],
      [OLD, NEW, newer],
    ];
    const result = await cleanupRustCaches(api, {
      repository: REPOSITORY,
      runId: 42,
      apply: true,
      retry: inertRetry(),
    });
    expect(result.deferred).toContain('changed or disappeared');
    expect(api.deletedIds).toEqual([]);
  });

  test('defers when the replacement disappeared or changed identity', async () => {
    for (const entries of [[OLD], [OLD, changedEntry(NEW, { version: 'b'.repeat(64) })]]) {
      const api = new FakeRustCacheApi();
      api.snapshots = [[OLD, NEW], entries];
      const result = await cleanupRustCaches(api, {
        repository: REPOSITORY,
        runId: 42,
        apply: true,
        retry: inertRetry(),
      });
      expect(result.deferred).toContain('changed or disappeared');
      expect(api.deletedIds).toEqual([]);
    }
  });

  test('rechecks writers before the second deletion', async () => {
    const api = new FakeRustCacheApi();
    const oldest = changedEntry(OLD, {
      id: 1,
      key: OLD.key.replace('f6a2f3f2', '12345678'),
      created_at: '2026-10-09T00:00:00Z',
    });
    api.entries = [oldest, OLD, NEW];
    api.writerSnapshots = [[], [{ ...MAIN_RUN, id: 43, status: 'queued' }]];
    const result = await cleanupRustCaches(api, {
      repository: REPOSITORY,
      runId: 42,
      apply: true,
      retry: inertRetry(),
    });
    expect(result.deletedIds).toEqual([OLD.id]);
    expect(result.deferred).toContain('43');
    expect(api.entries).toEqual([oldest, NEW]);
  });

  test('stops on lost replacement after deletion and API permission failures', async () => {
    const api = new FakeRustCacheApi();
    api.dropReplacementAfterDelete = true;
    await expect(
      cleanupRustCaches(api, {
        repository: REPOSITORY,
        runId: 42,
        apply: true,
        retry: inertRetry(),
      })
    ).rejects.toThrow(`Replacement cache ${NEW.id}`);
    const forbidden = new FakeRustCacheApi();
    forbidden.deleteError = new Error('DELETE returned 403');
    await expect(
      cleanupRustCaches(forbidden, {
        repository: REPOSITORY,
        runId: 42,
        apply: true,
        retry: inertRetry(),
      })
    ).rejects.toThrow('403');
    expect(forbidden.deletedIds).toEqual([]);
  });

  test.each([
    { label: 'pull request', trigger: { ...MAIN_RUN, event: 'pull_request' } },
    { label: 'other branch', trigger: { ...MAIN_RUN, head_branch: 'work' } },
    { label: 'fork', trigger: { ...MAIN_RUN, head_repository: { full_name: 'fork/mangostudio' } } },
    { label: 'unknown workflow', trigger: { ...MAIN_RUN, path: '.github/workflows/unknown.yml' } },
    { label: 'unfinished save', trigger: { ...MAIN_RUN, status: 'in_progress' } },
  ])('rejects a $label trigger before any deletion', async ({ trigger }) => {
    const api = new FakeRustCacheApi();
    api.trigger = trigger;
    await expect(
      cleanupRustCaches(api, {
        repository: REPOSITORY,
        runId: 42,
        apply: true,
        retry: inertRetry(),
      })
    ).rejects.toThrow('expected a completed same-repository main writer');
    expect(api.deletedIds).toEqual([]);
  });
});

class FakeGithubHttp extends ScriptedGitHubHttp {
  readonly environment = new RecordedRetryEnvironment();
  // One runtime for the adapter and the cleanup, as in the entrypoint.
  readonly retry = new GitHubRetry(STANDARD_RETRY_POLICY, this.environment);

  api(): GithubRustCacheApi {
    return new GithubRustCacheApi(REPOSITORY, 'fake-token', this.request.bind(this), this.retry);
  }

  cleanup(context: { runId?: number; apply: boolean }) {
    return cleanupRustCaches(this.api(), {
      repository: REPOSITORY,
      runId: MAIN_RUN.id,
      retry: this.retry,
      ...context,
    });
  }
}

// Advance a pending writer just after the running-status query. Scanning that
// status too early loses the writer from both snapshots.
class FakeStartingWriterHttp extends FakeGithubHttp {
  writer: CacheWriterRun = { ...MAIN_RUN, id: 43, status: 'pending' };

  override request(url: string, init: RequestInit): Promise<Response> {
    const status = new URL(url).searchParams.get('status');
    const runs = this.writer.status === status ? [{ ...this.writer }] : [];
    if (status === 'in_progress') this.writer = { ...this.writer, status: 'in_progress' };
    this.replies.push({ status: 200, body: { total_count: runs.length, workflow_runs: runs } });
    return super.request(url, init);
  }
}

describe('GitHub cache adapter', () => {
  test('follows every cache page with main-ref and Rust-prefix scope', async () => {
    const http = new FakeGithubHttp();
    const first = Array.from({ length: 100 }, (_, i) => changedEntry(OLD, { id: i + 1 }));
    http.replies = [
      { status: 200, body: { total_count: 101, actions_caches: first } },
      { status: 200, body: { total_count: 101, actions_caches: [changedEntry(NEW, { id: 101 })] } },
    ];
    expect(await http.api().listCaches()).toHaveLength(101);
    expect(http.calls.map(({ url }) => url.searchParams.get('page'))).toEqual(['1', '2']);
    for (const { url, init } of http.calls) {
      expect(url.searchParams.get('ref')).toBe('refs/heads/main');
      expect(url.searchParams.get('key')).toBe('v0-rust-');
      expect(init.redirect).toBe('error');
      expect(init.headers).toMatchObject({ authorization: 'Bearer fake-token' });
    }
  });

  test('rejects incomplete, changing, duplicate and malformed listings', async () => {
    // Each case names its own failure: a bare toThrow would also pass on a
    // retried transport failure from an unscripted request.
    for (const { body, message } of [
      {
        body: { total_count: 2, actions_caches: [OLD] },
        message: 'Incomplete actions_caches listing 1/2',
      },
      {
        body: { total_count: 2, actions_caches: [OLD, OLD] },
        message: 'Duplicate cache IDs in paginated listing',
      },
      {
        body: { total_count: 1, actions_caches: [{ ...OLD, id: -1 }] },
        message: 'Invalid cache entry',
      },
      {
        body: { total_count: 1, actions_caches: [{ ...OLD, size_in_bytes: 0 }] },
        message: 'Invalid cache entry',
      },
      { body: { total_count: 1, actions_caches: [null] }, message: 'Invalid cache entry null' },
      {
        body: { total_count: '1', actions_caches: [OLD] },
        message: 'expected an object with a nonnegative integer total_count',
      },
    ]) {
      const http = new FakeGithubHttp();
      http.replies = [{ status: 200, body }];
      await expect(http.api().listCaches()).rejects.toThrow(message);
      expect(http.calls).toHaveLength(1);
    }
    const changing = new FakeGithubHttp();
    changing.replies = [
      {
        status: 200,
        body: {
          total_count: 101,
          actions_caches: Array.from({ length: 100 }, (_, i) => ({ ...OLD, id: i + 1 })),
        },
      },
      { status: 200, body: { total_count: 102, actions_caches: [NEW] } },
    ];
    await expect(changing.api().listCaches()).rejects.toThrow(
      'Changing actions_caches total 101 -> 102'
    );
  });

  test('audits all active writer statuses while ignoring publishers, PRs and forks', async () => {
    const http = new FakeGithubHttp();
    const unrelated = {
      ...MAIN_RUN,
      id: 99,
      path: '.github/workflows/pr-qa-report.yml',
      event: 'workflow_run',
    };
    const run = {
      ...MAIN_RUN,
      status: 'requested',
      path: '.github/workflows/ci.yml@refs/heads/main',
    };
    http.replies = [
      {
        status: 200,
        body: {
          total_count: 4,
          workflow_runs: [
            run,
            unrelated,
            { ...run, id: 100, event: 'pull_request' },
            { ...run, id: 101, head_repository: { full_name: 'fork/repo' } },
          ],
        },
      },
      ...Array.from({ length: 4 }, () => ({
        status: 200,
        body: { total_count: 0, workflow_runs: [] },
      })),
    ];
    expect(await http.api().activeWriters()).toEqual([run]);
    expect(http.calls.map(({ url }) => url.searchParams.get('status'))).toEqual([
      'requested',
      'pending',
      'waiting',
      'queued',
      'in_progress',
    ]);
    expect(isMainCacheWriter(run, REPOSITORY)).toBe(true);
    expect(isMainCacheWriter(unrelated, REPOSITORY)).toBe(false);
  });

  test('detects a pending writer that starts during the status audit', async () => {
    const http = new FakeStartingWriterHttp();
    expect((await http.api().activeWriters()).map((run) => run.id)).toEqual([43]);
    expect(http.writer.status).toBe('in_progress');
  });

  test('reads the writer audit once and throws on an incomplete workflow listing', async () => {
    const http = new FakeGithubHttp();
    http.replies = [
      {
        status: 200,
        body: { total_count: 2, workflow_runs: [{ ...MAIN_RUN, status: 'requested' }] },
      },
    ];
    await expect(http.api().activeWriters()).rejects.toThrow(
      'Incomplete workflow_runs listing 1/2'
    );
    expect(http.calls).toHaveLength(1);
    expect(http.environment.waits).toEqual([]);
  });

  test('restarts the whole writer audit from the first status after an incomplete workflow listing', async () => {
    const http = new FakeGithubHttp();
    const empty = { status: 200, body: { total_count: 0, workflow_runs: [] } };
    http.replies = [
      { status: 200, body: MAIN_RUN },
      { status: 200, body: { total_count: 2, actions_caches: [NEW, OLD] } },
      // First audit: the 'requested' listing is incomplete, so the audit stops.
      { status: 200, body: { total_count: 2, workflow_runs: [{ ...MAIN_RUN, id: 43 }] } },
      // Second audit starts again at 'requested' and runs all five statuses.
      ...Array<typeof empty>(5).fill(empty),
      { status: 200, body: { total_count: 2, actions_caches: [NEW, OLD] } },
      { status: 204 },
      { status: 200, body: { total_count: 1, actions_caches: [NEW] } },
    ];
    const result = await http.cleanup({ apply: true });
    expect(result.deletedIds).toEqual([OLD.id]);
    expect(http.calls.slice(2, 4).map(({ url }) => url.searchParams.get('status'))).toEqual([
      'requested',
      'requested',
    ]);
    expect(http.environment.waits).toEqual([5_000]);
  });

  test('does not delete when the writer audit stays incomplete across every pass', async () => {
    const http = new FakeGithubHttp();
    const run = { ...MAIN_RUN, status: 'requested' };
    const incompleteAudit = { status: 200, body: { total_count: 2, workflow_runs: [run] } };
    http.replies = [
      { status: 200, body: MAIN_RUN },
      { status: 200, body: { total_count: 2, actions_caches: [NEW, OLD] } },
      incompleteAudit,
      incompleteAudit,
      incompleteAudit,
    ];
    await expect(http.cleanup({ apply: true })).rejects.toThrow(
      'Incomplete workflow_runs listing 1/2'
    );
    await expect(Promise.resolve(http.replies)).resolves.toEqual([]);
    expect(http.calls.map(({ init }) => init.method)).toEqual(['GET', 'GET', 'GET', 'GET', 'GET']);
    expect(http.environment.waits).toEqual([5_000, 10_000]);
  });

  test('restarts an incomplete cache inventory from page one before planning', async () => {
    const http = new FakeGithubHttp();
    const stalePage = Array.from({ length: 100 }, (_, index) =>
      changedEntry(OLD, { id: index + 1 })
    );
    http.replies = [
      { status: 200, body: MAIN_RUN },
      { status: 200, body: { total_count: 101, actions_caches: stalePage } },
      { status: 200, body: { total_count: 101, actions_caches: [] } },
      { status: 200, body: { total_count: 2, actions_caches: [NEW, OLD] } },
    ];
    const result = await http.cleanup({ apply: false });
    expect(result.planned.map(({ entry, replacement }) => [entry.id, replacement.id])).toEqual([
      [OLD.id, NEW.id],
    ]);
    expect(http.calls.slice(1).map(({ url }) => url.searchParams.get('page'))).toEqual([
      '1',
      '2',
      '1',
    ]);
    expect(http.environment.waits).toEqual([5_000]);
  });

  test('two incomplete cache inventories then a complete one are planned from the complete one', async () => {
    const http = new FakeGithubHttp();
    http.replies = [
      { status: 200, body: MAIN_RUN },
      { status: 200, body: { total_count: 7, actions_caches: [NEW] } },
      { status: 200, body: { total_count: 1, actions_caches: [] } },
      { status: 200, body: { total_count: 2, actions_caches: [NEW, OLD] } },
    ];
    const result = await http.cleanup({ apply: false });
    expect(result.planned).toHaveLength(1);
    expect(http.environment.waits).toEqual([5_000, 10_000]);
  });

  test('a cache inventory that stays incomplete fails closed with the named listing', async () => {
    const http = new FakeGithubHttp();
    const partial = { status: 200, body: { total_count: 2, actions_caches: [NEW] } };
    http.replies = [{ status: 200, body: MAIN_RUN }, partial, partial, partial];
    await expect(http.cleanup({ apply: true })).rejects.toThrow(
      'Incomplete actions_caches listing 1/2; expected every entry; main Rust cache listing gave up after 3 attempts'
    );
    expect(http.calls.map(({ init }) => init.method)).not.toContain('DELETE');
  });

  test('audits writers again before retrying per-deletion cache revalidation', async () => {
    const http = new FakeGithubHttp();
    const writer = { ...MAIN_RUN, id: 43, status: 'requested' };
    const empty = { status: 200, body: { total_count: 0, workflow_runs: [] } };
    http.replies = [
      { status: 200, body: MAIN_RUN },
      { status: 200, body: { total_count: 2, actions_caches: [NEW, OLD] } },
      empty,
      empty,
      empty,
      empty,
      empty,
      { status: 200, body: { total_count: 3, actions_caches: [NEW, OLD] } },
      { status: 200, body: { total_count: 1, workflow_runs: [writer] } },
      empty,
      empty,
      empty,
      empty,
    ];
    const result = await http.cleanup({ apply: true });
    expect(result.deferred).toBe('Active main cache writers: 43');
    expect(http.calls.map(({ init }) => init.method)).not.toContain('DELETE');
    expect(http.calls.slice(8).map(({ url }) => url.searchParams.get('status'))).toEqual([
      'requested',
      'pending',
      'waiting',
      'queued',
      'in_progress',
    ]);
  });

  test('refuses deletion when per-deletion revalidation stays incomplete', async () => {
    const http = new FakeGithubHttp();
    const empty = { status: 200, body: { total_count: 0, workflow_runs: [] } };
    const incompleteRevalidation = [
      ...Array<typeof empty>(5).fill(empty),
      { status: 200, body: { total_count: 3, actions_caches: [OLD] } },
    ];
    http.replies = [
      { status: 200, body: MAIN_RUN },
      { status: 200, body: { total_count: 2, actions_caches: [NEW, OLD] } },
      ...incompleteRevalidation,
      ...incompleteRevalidation,
      ...incompleteRevalidation,
    ];
    await expect(http.cleanup({ apply: true })).rejects.toThrow(
      'Incomplete actions_caches listing 1/3'
    );
    expect(http.replies).toEqual([]);
    expect(http.calls.map(({ init }) => init.method)).not.toContain('DELETE');
    expect(http.environment.waits).toEqual([5_000, 10_000]);
  });

  test('retries revalidation and the retained-replacement check around one DELETE', async () => {
    const http = new FakeGithubHttp();
    const empty = { status: 200, body: { total_count: 0, workflow_runs: [] } };
    const emptyAudit = Array<typeof empty>(5).fill(empty);
    const both = { status: 200, body: { total_count: 2, actions_caches: [NEW, OLD] } };
    http.replies = [
      { status: 200, body: MAIN_RUN },
      both,
      ...emptyAudit,
      { status: 200, body: { total_count: 3, actions_caches: [NEW, OLD] } },
      ...emptyAudit,
      both,
      { status: 204 },
      { status: 200, body: { total_count: 2, actions_caches: [NEW] } },
      { status: 200, body: { total_count: 1, actions_caches: [NEW] } },
    ];
    const result = await http.cleanup({ apply: true });
    expect(result.deletedIds).toEqual([OLD.id]);
    expect(
      http.calls.filter(({ init }) => init.method === 'DELETE').map(({ url }) => url.pathname)
    ).toEqual([`/repos/${REPOSITORY}/actions/caches/${OLD.id}`]);
    expect(http.replies).toEqual([]);
  });

  test('audits writers again when a retry wait passed between the audit and the DELETE', async () => {
    const http = new FakeGithubHttp();
    const empty = { status: 200, body: { total_count: 0, workflow_runs: [] } };
    const emptyAudit = Array<typeof empty>(5).fill(empty);
    const both = { status: 200, body: { total_count: 2, actions_caches: [NEW, OLD] } };
    http.replies = [
      { status: 200, body: MAIN_RUN },
      both,
      ...emptyAudit,
      // The revalidation listing fails once and succeeds after a 5 s wait: the audit above is now stale.
      { status: 502, text: 'Bad Gateway' },
      both,
      ...emptyAudit,
      both,
      { status: 204 },
      { status: 200, body: { total_count: 1, actions_caches: [NEW] } },
    ];
    // Read the requests first: a missing re-audit shows up as a stray DELETE here, not as a scripted-reply error.
    const result = await http.cleanup({ apply: true }).catch((error: Error) => error);
    const sequence = http.calls.map(({ url, init }) =>
      init.method === 'DELETE'
        ? 'DELETE'
        : (url.searchParams.get('status') ?? url.pathname.split('/').at(-1))
    );
    const audit = ['requested', 'pending', 'waiting', 'queued', 'in_progress'];
    expect(
      sequence,
      'expected a second writer audit after the retry wait and before the DELETE'
    ).toEqual([
      '42',
      'caches',
      ...audit,
      'caches',
      'caches',
      ...audit,
      'caches',
      'DELETE',
      'caches',
    ]);
    expect(result).toMatchObject({ deletedIds: [OLD.id] });
    expect(http.environment.waits).toEqual([5_000]);
  });

  test('a writer that starts during the retry wait defers the deletion', async () => {
    const http = new FakeGithubHttp();
    const empty = { status: 200, body: { total_count: 0, workflow_runs: [] } };
    const writer = { ...MAIN_RUN, id: 43, status: 'requested' };
    const both = { status: 200, body: { total_count: 2, actions_caches: [NEW, OLD] } };
    http.replies = [
      { status: 200, body: MAIN_RUN },
      both,
      ...Array<typeof empty>(5).fill(empty),
      { status: 502, text: 'Bad Gateway' },
      both,
      // The second audit sees the writer that appeared while the retry slept.
      { status: 200, body: { total_count: 1, workflow_runs: [writer] } },
      ...Array<typeof empty>(4).fill(empty),
    ];
    const result = await http.cleanup({ apply: true }).catch((error: Error) => error);
    expect(
      http.calls.map(({ init }) => init.method),
      'expected no DELETE after the writer that appeared during the retry wait'
    ).not.toContain('DELETE');
    expect(result).toMatchObject({ deferred: 'Active main cache writers: 43' });
  });

  test.each([
    { label: 'a timeout', first: { networkError: 'timed out' } },
    { label: 'a 502', first: { status: 502, text: 'Bad Gateway' } },
  ])('a DELETE retried after $label that then answers 404 counts as deleted', async ({ first }) => {
    const http = new FakeGithubHttp();
    const empty = { status: 200, body: { total_count: 0, workflow_runs: [] } };
    const both = { status: 200, body: { total_count: 2, actions_caches: [NEW, OLD] } };
    http.replies = [
      { status: 200, body: MAIN_RUN },
      both,
      ...Array<typeof empty>(5).fill(empty),
      both,
      first,
      { status: 404 },
      { status: 200, body: { total_count: 1, actions_caches: [NEW] } },
    ];
    const result = await http.cleanup({ apply: true });
    expect(
      result.deletedIds,
      'expected the cache removed by the first DELETE attempt to be reported deleted'
    ).toEqual([OLD.id]);
  });

  test('a first-attempt DELETE 404 is not counted as deleted', async () => {
    const http = new FakeGithubHttp();
    const empty = { status: 200, body: { total_count: 0, workflow_runs: [] } };
    const both = { status: 200, body: { total_count: 2, actions_caches: [NEW, OLD] } };
    http.replies = [
      { status: 200, body: MAIN_RUN },
      both,
      ...Array<typeof empty>(5).fill(empty),
      both,
      { status: 404 },
      { status: 200, body: { total_count: 1, actions_caches: [NEW] } },
    ];
    const result = await http.cleanup({ apply: true });
    expect(result.deletedIds).toEqual([]);
  });

  test('rejects duplicate workflow run IDs across pages of one status', async () => {
    const http = new FakeGithubHttp();
    const first = Array.from({ length: 100 }, (_, index) => ({
      ...MAIN_RUN,
      id: index + 1000,
      status: 'requested',
      path: '.github/workflows/pr-qa-report.yml',
    }));
    http.replies = [
      { status: 200, body: { total_count: 101, workflow_runs: first } },
      { status: 200, body: { total_count: 101, workflow_runs: [first[99]] } },
      ...Array.from({ length: 4 }, () => ({
        status: 200,
        body: { total_count: 0, workflow_runs: [] },
      })),
    ];
    await expect(http.api().activeWriters()).rejects.toThrow('Duplicate workflow run IDs');
    expect(http.calls).toHaveLength(2);
  });

  test('allows the same writer to appear in separate status snapshots', async () => {
    const http = new FakeGithubHttp();
    http.replies = [
      {
        status: 200,
        body: { total_count: 1, workflow_runs: [{ ...MAIN_RUN, status: 'requested' }] },
      },
      {
        status: 200,
        body: { total_count: 1, workflow_runs: [{ ...MAIN_RUN, status: 'pending' }] },
      },
      ...Array.from({ length: 3 }, () => ({
        status: 200,
        body: { total_count: 0, workflow_runs: [] },
      })),
    ];
    expect((await http.api().activeWriters()).map((run) => run.id)).toEqual([MAIN_RUN.id]);
  });

  test('bounds an oversized cache listing without accepting a partial page set', async () => {
    const http = new FakeGithubHttp();
    http.replies = Array.from({ length: 100 }, (_, page) => ({
      status: 200,
      body: {
        total_count: 10001,
        actions_caches: Array.from({ length: 100 }, (_, index) => ({
          ...OLD,
          id: page * 100 + index + 1,
        })),
      },
    }));
    await expect(http.api().listCaches()).rejects.toThrow('Exceeded 100 actions_caches pages');
    expect(http.calls).toHaveLength(100);
  });

  test('retries a 502 on the trigger run read', async () => {
    const http = new FakeGithubHttp();
    http.replies = [
      { status: 502, text: 'Bad Gateway' },
      { status: 200, body: MAIN_RUN },
    ];
    expect(await http.api().getRun(42)).toEqual(MAIN_RUN);
    expect(http.environment.waits).toEqual([5_000]);
  });

  test('names the request and the received body when the trigger run is not JSON', async () => {
    const http = new FakeGithubHttp();
    http.replies = [{ status: 200, text: '<html>Unicorn</html>' }];
    await expect(http.api().getRun(42)).rejects.toThrow(
      'Invalid GET /runs/42; expected a workflow run object as JSON (HTTP 200) | received <html>Unicorn</html>'
    );
  });

  test('independently reads the trigger run and rejects invalid run payloads', async () => {
    const http = new FakeGithubHttp();
    http.replies = [{ status: 200, body: MAIN_RUN }];
    expect(await http.api().getRun(42)).toEqual(MAIN_RUN);
    expect(http.calls[0].url.pathname).toEndWith('/runs/42');
    for (const { body, message } of [
      { body: null, message: 'Invalid workflow run null' },
      { body: { ...MAIN_RUN, id: 43 }, message: 'Unexpected run ID 43; expected 42' },
      { body: { ...MAIN_RUN, head_repository: null }, message: 'Invalid workflow run' },
    ]) {
      const invalid = new FakeGithubHttp();
      invalid.replies = [{ status: 200, body }];
      await expect(invalid.api().getRun(42)).rejects.toThrow(message);
      expect(invalid.calls).toHaveLength(1);
    }
    await expect(http.api().getRun(0)).rejects.toThrow('Invalid run ID 0');
  });

  test('deletes one numeric ID, accepts already absent, and propagates forbidden writes', async () => {
    const http = new FakeGithubHttp();
    http.replies = [{ status: 204 }, { status: 404 }, { status: 403 }, { status: 200 }];
    const api = http.api();
    expect(await api.deleteCache(OLD.id)).toBe(true);
    expect(await api.deleteCache(OLD.id)).toBe(false);
    await expect(api.deleteCache(OLD.id)).rejects.toThrow('returned 403');
    await expect(api.deleteCache(OLD.id)).rejects.toThrow('expected 204 or 404');
    expect(http.calls.every(({ init }) => init.method === 'DELETE')).toBe(true);
    expect(
      http.calls.every(({ url }) => url.pathname.endsWith(`/caches/${OLD.id}`) && url.search === '')
    ).toBe(true);
    await expect(api.deleteCache(-1)).rejects.toThrow('Invalid cache ID -1');
    expect(() => new GithubRustCacheApi('../unsafe', 'fake-token')).toThrow('expected owner/repo');
    expect(() => new GithubRustCacheApi(REPOSITORY, '')).toThrow(
      'expected a nonempty Actions token'
    );
  });
});

describe('cleanup execution context', () => {
  const env = {
    GITHUB_EVENT_NAME: 'workflow_run',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: REPOSITORY,
  };

  test('requires main execution independently of the upstream run validation', () => {
    expect(readCleanupContext(env, { workflow_run: { id: 42 } })).toEqual({
      repository: REPOSITORY,
      runId: 42,
    });
    expect(() =>
      readCleanupContext(
        { ...env, GITHUB_EVENT_NAME: 'pull_request' },
        { workflow_run: { id: 42 } }
      )
    ).toThrow('expected workflow_run on refs/heads/main');
    expect(() =>
      readCleanupContext({ ...env, GITHUB_REF: 'refs/pull/99/merge' }, { workflow_run: { id: 42 } })
    ).toThrow('expected workflow_run on refs/heads/main');
    expect(() =>
      readCleanupContext({ ...env, GITHUB_REPOSITORY: '' }, { workflow_run: { id: 42 } })
    ).toThrow('expected owner/repo');
    expect(() => readCleanupContext(env, { workflow_run: { id: '42' } })).toThrow(
      'expected a positive integer'
    );
    expect(() => readCleanupContext(env, null)).toThrow('expected a positive integer');
  });
});

describe('--fixture listing', () => {
  const FIXTURE = 'scripts/tests/fixtures/rust-cache-listing.json';
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const fixtureWith = (contents: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mango-rust-cache-fixture-'));
    temps.push(dir);
    const path = join(dir, 'listing.json');
    writeFileSync(path, contents);
    return path;
  };

  test('accepts the captured listing and returns every entry', () => {
    expect(readFixtureListing(FIXTURE)).toEqual(listing.actions_caches);
  });

  test.each([
    [
      'an object instead of an array',
      '{"actions_caches":{"a":1}}',
      'received {"actions_caches":{"a":1}}',
    ],
    ['a bare array', '[]', 'received []'],
    ['a missing actions_caches key', '{"total_count":0}', 'received {"total_count":0}'],
    ['null', 'null', 'received null'],
    ['truncated JSON', '{"actions_caches":', 'received invalid JSON'],
  ])('names the file and expected shape for %s', (_name, contents, received) => {
    const path = fixtureWith(contents);
    expect(() => readFixtureListing(path)).toThrow(
      `Invalid fixture ${path}: expected {"actions_caches": [<cache entry>, ...]} | ${received}`
    );
  });

  test('names the entry index when one entry is not a cache entry', () => {
    const path = fixtureWith(
      JSON.stringify({ actions_caches: [listing.actions_caches[0], { id: 0 }] })
    );
    expect(() => readFixtureListing(path)).toThrow(
      `Invalid fixture ${path} at actions_caches[1]: Invalid cache entry {"id":0}; expected a positive ID/size`
    );
  });

  test('names a fixture that cannot be read', () => {
    const missing = join(tmpdir(), 'mango-rust-cache-fixture-missing', 'listing.json');
    expect(() => readFixtureListing(missing)).toThrow(`Cannot read fixture ${missing}`);
  });

  // The old CLI path died with `entries.map is not a function`.
  test('the CLI exits 1 with the shape message instead of a TypeError', () => {
    const path = fixtureWith('{"actions_caches":{"a":1}}');
    const run = Bun.spawnSync({
      cmd: ['bun', 'scripts/ci/rust-cache-cleanup.ts', '--fixture', path],
      cwd: ROOT_DIR,
    });
    const stderr = run.stderr.toString();
    expect(run.exitCode).toBe(1);
    expect(stderr).toContain(
      `Invalid fixture ${path}: expected {"actions_caches": [<cache entry>, ...]}`
    );
    expect(stderr).not.toContain('entries.map');
  });
});
