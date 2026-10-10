import { describe, expect, test } from 'bun:test';
import { cleanupRustCaches } from '../ci/rust-cache/cleanup';
import {
  type CacheWriterRun,
  GithubRustCacheApi,
  isMainCacheWriter,
  type RustCacheApi,
} from '../ci/rust-cache/github';
import { type RustCacheEntry, selectRustCacheDeletions } from '../ci/rust-cache/selection';
import { readCleanupContext } from '../ci/rust-cache-cleanup';
import { readText } from './support/read-text';

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
    const result = await cleanupRustCaches(api, { repository: REPOSITORY, runId: 42, apply: true });
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
    });
    expect(result.planned).toHaveLength(1);
    expect(api.deletedIds).toEqual([]);
  });

  test('defers when a main writer is saving', async () => {
    const api = new FakeRustCacheApi();
    api.writers = [{ ...MAIN_RUN, id: 43, status: 'in_progress' }];
    const result = await cleanupRustCaches(api, { repository: REPOSITORY, runId: 42, apply: true });
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
    const result = await cleanupRustCaches(api, { repository: REPOSITORY, runId: 42, apply: true });
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
    const result = await cleanupRustCaches(api, { repository: REPOSITORY, runId: 42, apply: true });
    expect(result.deletedIds).toEqual([OLD.id]);
    expect(result.deferred).toContain('43');
    expect(api.entries).toEqual([oldest, NEW]);
  });

  test('stops on lost replacement after deletion and API permission failures', async () => {
    const api = new FakeRustCacheApi();
    api.dropReplacementAfterDelete = true;
    await expect(
      cleanupRustCaches(api, { repository: REPOSITORY, runId: 42, apply: true })
    ).rejects.toThrow(`Replacement cache ${NEW.id}`);
    const forbidden = new FakeRustCacheApi();
    forbidden.deleteError = new Error('DELETE returned 403');
    await expect(
      cleanupRustCaches(forbidden, { repository: REPOSITORY, runId: 42, apply: true })
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
      cleanupRustCaches(api, { repository: REPOSITORY, runId: 42, apply: true })
    ).rejects.toThrow('expected a completed same-repository main writer');
    expect(api.deletedIds).toEqual([]);
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

  api(): GithubRustCacheApi {
    return new GithubRustCacheApi(REPOSITORY, 'fake-token', this.request.bind(this));
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
    for (const body of [
      { total_count: 2, actions_caches: [OLD] },
      { total_count: 2, actions_caches: [OLD, OLD] },
      { total_count: 1, actions_caches: [{ ...OLD, id: -1 }] },
      { total_count: 1, actions_caches: [{ ...OLD, size_in_bytes: 0 }] },
      { total_count: 1, actions_caches: [null] },
      { total_count: '1', actions_caches: [OLD] },
    ]) {
      const http = new FakeGithubHttp();
      http.replies = [{ status: 200, body }];
      await expect(http.api().listCaches()).rejects.toThrow();
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
    const run = { ...MAIN_RUN, status: 'queued', path: '.github/workflows/ci.yml@refs/heads/main' };
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
      'queued',
      'in_progress',
      'waiting',
      'pending',
      'requested',
    ]);
    expect(isMainCacheWriter(run, REPOSITORY)).toBe(true);
    expect(isMainCacheWriter(unrelated, REPOSITORY)).toBe(false);
  });

  test('independently reads the trigger run and rejects invalid run payloads', async () => {
    const http = new FakeGithubHttp();
    http.replies = [{ status: 200, body: MAIN_RUN }];
    expect(await http.api().getRun(42)).toEqual(MAIN_RUN);
    expect(http.calls[0].url.pathname).toEndWith('/runs/42');
    for (const body of [null, { ...MAIN_RUN, id: 43 }, { ...MAIN_RUN, head_repository: null }]) {
      const invalid = new FakeGithubHttp();
      invalid.replies = [{ status: 200, body }];
      await expect(invalid.api().getRun(42)).rejects.toThrow();
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
