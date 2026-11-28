import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseScopedCacheKey } from '../ci/cache-families';
import { parseFixtureClock } from '../ci/rust-cache-cleanup';
import {
  cleanupRustCaches,
  planCacheDeletions,
  selectCacheDeletions,
} from '../ci/rust-cache/cleanup';
import { parseRustCacheKey } from '../ci/rust-cache/families';
import type { CacheWriterRun, RustCacheApi } from '../ci/rust-cache/github';
import {
  RETENTION_DELETIONS_PER_RUN,
  RETENTION_KEEP,
  RETENTION_QUIET_MS,
  RETENTION_RULES,
  selectRetentionDeletions,
} from '../ci/rust-cache/retention';
import { type RustCacheEntry, selectRustCacheDeletions } from '../ci/rust-cache/selection';
import { GitHubRetry, STANDARD_RETRY_POLICY } from '../lib/github-retry';
import { readText } from './support/read-text';
import { RecordedRetryEnvironment } from './support/scripted-github-http';

const REPOSITORY = 'juliopolycarpo/mangostudio';
const NOW = Date.parse('2026-11-28T06:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BUN = '1.4.6-canary.1+7bb427f3b';
const TURBO_HASH = '63fc0ed49e1e4191607b9ae07d639b0c723290a6367bc13b34ab24bd962835ad';
const TOOLS_HASH = 'ad0bfda79b14e33c28d7f29e995ecd01f02a0828e5bac150c57c9393652c7941';
const ARCHIVE = 'c'.repeat(64);

let nextId = 1000;

/** An entry saved `ageMs` before NOW. Every entry is old enough for the quiet window by default. */
function entry(key: string, ageMs: number, changes: Partial<RustCacheEntry> = {}): RustCacheEntry {
  const created = new Date(NOW - ageMs).toISOString();
  return {
    id: nextId++,
    key,
    ref: 'refs/heads/main',
    version: ARCHIVE,
    created_at: created,
    last_accessed_at: created,
    size_in_bytes: 1_000_000,
    ...changes,
  };
}

const turboKey = (kind: 'build' | 'check', run: number, bun = BUN, platform = 'Linux-X64-v1') =>
  `${platform}-turbo-main-${kind}-bun-${bun}-turbo-2.11.11-${TURBO_HASH}-${run}-1`;
const timingsKey = (run: number, shards = 2) =>
  `Linux-X64-v1-timings-main-test-shard-${shards}-${run}`;
const lintToolsKey = (hash = TOOLS_HASH) => `Linux-X64-v1-lint-tools-main-${hash}`;

/** `count` turbo build entries from distinct runs, newest first: age 1 day, 2 days, ... */
function turboRuns(count: number, kind: 'build' | 'check' = 'build'): RustCacheEntry[] {
  return Array.from({ length: count }, (_, index) =>
    entry(turboKey(kind, 5000 - index, `1.4.6-canary.1+rev${index}`), (index + 1) * 24 * HOUR)
  );
}

const deletedKeys = (entries: readonly RustCacheEntry[], now = NOW): string[] =>
  selectRetentionDeletions(entries, now).map(({ entry: planned }) => planned.key);

describe('retention rule selection', () => {
  test('keeps the newest entries of a lane and deletes the rest, oldest first', () => {
    const runs = turboRuns(6);
    // Shuffled: the order of the listing must not decide the result.
    const plan = selectRetentionDeletions(
      [runs[4], runs[0], runs[5], runs[2], runs[1], runs[3]],
      NOW
    );
    expect(plan.map(({ entry: planned }) => planned.id)).toEqual([
      runs[5].id,
      runs[4].id,
      runs[3].id,
    ]);
    expect(plan.every(({ replacement }) => replacement.id === runs[0].id)).toBe(true);
    expect(RETENTION_KEEP).toBe(3);
  });

  test('reads a hyphenated Turbo or Bun version instead of failing the run', () => {
    const prerelease = Array.from({ length: 5 }, (_, i) =>
      entry(
        `Linux-X64-v1-turbo-main-check-bun-1.4.6-canary.1+abc${i}-turbo-2.12.0-canary.${i}-${TURBO_HASH}-${600 + i}-1`,
        (i + 1) * 24 * HOUR
      )
    );
    expect(deletedKeys(prerelease)).toEqual([prerelease[4].key, prerelease[3].key]);
  });

  test('keeps recognising the retired test lane of the turbo family', () => {
    const retired = Array.from({ length: 4 }, (_, i) =>
      entry(
        `Linux-X64-v1-turbo-main-test-bun-1.4.2+744846f84-turbo-2.11.7-${TURBO_HASH}-${38086771461 + i}-1`,
        (i + 1) * 24 * HOUR
      )
    );
    expect(deletedKeys(retired)).toEqual([retired[3].key]);
  });

  test('keeps recognising turbo keys written before rotation, which carry no run suffix', () => {
    const preRotation = Array.from({ length: 4 }, (_, i) =>
      entry(
        `Linux-X64-v1-turbo-main-build-bun-1.4.2+744846f84-turbo-2.11.7-${`${i}`.repeat(64)}`,
        (i + 1) * 24 * HOUR
      )
    );
    expect(deletedKeys(preRotation)).toEqual([preRotation[3].key]);
  });

  test('groups per restore prefix across validities, not per exact validity', () => {
    // Six revisions, one entry each: grouping on the full validity would keep all six.
    expect(selectRetentionDeletions(turboRuns(6), NOW)).toHaveLength(3);
  });

  test('keeps the build and check lanes, the platforms and the families apart', () => {
    const entries = [
      ...turboRuns(3, 'build'),
      ...turboRuns(3, 'check'),
      ...Array.from({ length: 3 }, (_, i) =>
        entry(turboKey('build', 7000 - i, BUN, 'Windows-X64-v1'), (i + 1) * 24 * HOUR)
      ),
      ...Array.from({ length: 3 }, (_, i) => entry(timingsKey(9000 - i), (i + 1) * 24 * HOUR)),
      entry(lintToolsKey(), 24 * HOUR),
    ];
    expect(selectRetentionDeletions(entries, NOW)).toEqual([]);
  });

  test('applies one rule per named family: timings and lint-tools', () => {
    const timings = Array.from({ length: 5 }, (_, i) =>
      entry(timingsKey(9000 - i), (i + 1) * 24 * HOUR)
    );
    const tools = Array.from({ length: 4 }, (_, i) =>
      entry(lintToolsKey(`${i}`.repeat(64)), (i + 1) * 24 * HOUR)
    );
    expect(deletedKeys(timings)).toEqual([timings[4].key, timings[3].key]);
    expect(deletedKeys(tools)).toEqual([tools[3].key]);
    expect(RETENTION_RULES.map((rule) => rule.family).sort()).toEqual([
      'lint-tools',
      'timings',
      'turbo',
    ]);
  });

  test('lets entries of an older epoch age out against the current one', () => {
    const current = turboRuns(3);
    const staleEpoch = [
      entry(turboKey('build', 10, BUN, 'Linux-X64-v0'), 30 * 24 * HOUR),
      entry(turboKey('build', 11, BUN, 'Linux-X64-v0'), 31 * 24 * HOUR),
    ];
    expect(deletedKeys([...current, ...staleEpoch])).toEqual(
      staleEpoch.map((stale) => stale.key).reverse()
    );
  });

  test('breaks a created_at tie by cache ID instead of keeping or deleting the group', () => {
    const same = new Date(NOW - 5 * 24 * HOUR).toISOString();
    const tied = Array.from({ length: 5 }, (_, i) =>
      entry(timingsKey(100 + i), 0, { id: 10 + i, created_at: same, last_accessed_at: same })
    );
    const plan = selectRetentionDeletions(tied, NOW);
    // IDs 14, 13 and 12 are the newest three; 10 and 11 go, lowest ID first.
    expect(plan.map(({ entry: planned }) => planned.id)).toEqual([10, 11]);
    expect(plan.every(({ replacement }) => replacement.id === 14)).toBe(true);
  });

  describe('quiet window', () => {
    const lane = (): RustCacheEntry[] => turboRuns(4);

    test.each([
      { label: 'created 30 minutes ago', age: 30 * MINUTE, deleted: false },
      { label: 'created 59 minutes ago', age: 59 * MINUTE, deleted: false },
      { label: 'created exactly one hour ago', age: HOUR, deleted: true },
      { label: 'created two days ago, never restored', age: 48 * HOUR, deleted: true },
    ])('a fourth entry $label', ({ label, age, deleted }) => {
      // Three newer entries (1 to 3 minutes old) push the fourth out of the newest three.
      const newest = [1, 2, 3].map((minutes) =>
        entry(turboKey('build', 6000 - minutes), minutes * MINUTE)
      );
      const fourth = entry(turboKey('build', 1), age);
      expect(
        selectRetentionDeletions([...newest, fourth], NOW).map((plan) => plan.entry.id),
        `fourth entry ${label}: expected ${deleted ? 'its deletion' : 'no deletion'}`
      ).toEqual(deleted ? [fourth.id] : []);
    });

    test('an old entry restored within the hour is plausibly in use and stays', () => {
      const [first, second, third, fourth] = lane();
      const restored = { ...fourth, last_accessed_at: new Date(NOW - 10 * MINUTE).toISOString() };
      expect(selectRetentionDeletions([first, second, third, restored], NOW)).toEqual([]);
      const idle = { ...fourth, last_accessed_at: new Date(NOW - 2 * HOUR).toISOString() };
      expect(selectRetentionDeletions([first, second, third, idle], NOW)).toHaveLength(1);
      expect(RETENTION_QUIET_MS).toBe(HOUR);
    });

    test('a listing without last_accessed_at judges by creation alone', () => {
      const [first, second, third, fourth] = lane();
      const { last_accessed_at: _omitted, ...withoutAccess } = fourth;
      expect(selectRetentionDeletions([first, second, third, withoutAccess], NOW)).toHaveLength(1);
    });

    test('a quiet entry still counts toward the newest three', () => {
      // Four entries created within the hour: nothing may be deleted, and the oldest of them
      // is not "pushed out" by a rule that ignores recent entries when it counts.
      const recent = Array.from({ length: 4 }, (_, i) =>
        entry(timingsKey(200 + i), (i + 1) * 5 * MINUTE)
      );
      expect(selectRetentionDeletions(recent, NOW)).toEqual([]);
    });
  });

  describe('scope', () => {
    const stale = (): RustCacheEntry[] => turboRuns(6);

    test('never touches pull request refs, other branches or non-main scopes', () => {
      const protectedEntries = stale().flatMap((main) => [
        { ...main, id: main.id + 100_000, ref: 'refs/pull/7/merge' },
        { ...main, id: main.id + 200_000, ref: 'refs/heads/work' },
        {
          ...main,
          id: main.id + 300_000,
          key: main.key.replace('-turbo-main-', '-turbo-run-123-'),
        },
        { ...main, id: main.id + 400_000, key: main.key.replace('-turbo-main-', '-turbo-pr-7-') },
      ]);
      expect(selectRetentionDeletions(protectedEntries, NOW)).toEqual([]);
    });

    test('never touches a family no rule names', () => {
      const unnamed = Array.from({ length: 8 }, (_, i) => [
        entry(`Linux-X64-v1-playwright-main-1.2.3-${i}`, (i + 1) * 24 * HOUR),
        entry(`Linux-X64-v1-bun-main-${i}`, (i + 1) * 24 * HOUR),
        entry(
          `v0-rust-profile-${'a'.repeat(64)}-rust-Linux-x64-1234abcd-${i}0000000`,
          (i + 1) * 24 * HOUR
        ),
        entry(`something-else-${i}`, (i + 1) * 24 * HOUR),
      ]).flat();
      expect(selectRetentionDeletions(unnamed, NOW)).toEqual([]);
    });
  });

  describe('fails closed', () => {
    test.each([
      {
        label: 'a turbo lane that is neither build nor check',
        key: `Linux-X64-v1-turbo-main-lint-bun-1.4.6-turbo-2.11.11-${TURBO_HASH}-5-1`,
        family: 'turbo',
      },
      {
        label: 'a turbo key whose hash is not a sha256',
        key: `Linux-X64-v1-turbo-main-build-bun-${BUN}-turbo-2.11.11-abc123-5-1`,
        family: 'turbo',
      },
      {
        label: 'a timings shard count that is not a number',
        key: 'Linux-X64-v1-timings-main-test-shard-x-9',
        family: 'timings',
      },
      {
        label: 'a timings key with no validity',
        key: 'Linux-X64-v1-timings-main-',
        family: 'timings',
      },
      {
        label: 'a lint-tools hash that is too short',
        key: 'Linux-X64-v1-lint-tools-main-abc123',
        family: 'lint-tools',
      },
    ])('throws on $label naming the key and the expected grammar', ({ key, family }) => {
      const entries = [...turboRuns(6), entry(key, 24 * HOUR)];
      expect(() => selectRetentionDeletions(entries, NOW)).toThrow(
        `Unrecognised cache key ${JSON.stringify(key)}`
      );
      expect(() => selectRetentionDeletions(entries, NOW)).toThrow(
        `in retained family ${family}; expected <os>-<arch>-<epoch>-${family}-main-`
      );
    });

    test('throws on an unreadable created_at or last_accessed_at', () => {
      const entries = turboRuns(6);
      expect(() =>
        selectRetentionDeletions(
          [...entries, { ...entries[0], id: 1, created_at: 'yesterday' }],
          NOW
        )
      ).toThrow('Invalid created_at "yesterday" on cache 1');
      const old = entries[5];
      expect(() =>
        selectRetentionDeletions(
          [...entries.slice(0, 5), { ...old, last_accessed_at: 'later' }],
          NOW
        )
      ).toThrow(`Invalid last_accessed_at "later" on cache ${old.id}`);
    });

    test('an unrecognised key on a pull request ref is not a failure', () => {
      const bad = entry('Linux-X64-v1-turbo-main-garbage', 24 * HOUR, { ref: 'refs/pull/7/merge' });
      expect(selectRetentionDeletions([bad], NOW)).toEqual([]);
    });
  });
});

describe('parseScopedCacheKey', () => {
  test('splits platform, epoch, family, scope and validity of a cache-scoped key', () => {
    expect(parseScopedCacheKey(timingsKey(4321))).toEqual({
      platform: 'Linux-X64',
      epoch: 'v1',
      family: 'timings',
      scope: 'main',
      validity: 'test-shard-2-4321',
    });
    expect(parseScopedCacheKey(turboKey('check', 7, BUN, 'Windows-ARM64-v2'))).toMatchObject({
      platform: 'Windows-ARM64',
      epoch: 'v2',
      family: 'turbo',
      scope: 'main',
      validity: `check-bun-${BUN}-turbo-2.11.11-${TURBO_HASH}-7-1`,
    });
  });

  test.each([
    'v0-rust-profile-abc',
    'Linux-X64-v1-unknownfamily-main-x',
    'Linux-X64-v1-turbo-main-x-turbo-main-y',
    'plain',
  ])('returns undefined for %p, which names no single owner', (key) => {
    expect(parseScopedCacheKey(key)).toBeUndefined();
  });
});

describe('retired fuzz keys and the Rust grammar', () => {
  const profile = `v0-rust-profile-${'1'.repeat(64)}-fuzz-Linux-x64-8272a5e9-aaaa1111`;
  const bare = (environment: string, lock: string) =>
    `v0-rust-fuzz-Linux-x64-${environment}-${lock}`;
  const archive = 'f'.repeat(64);

  test('reads the bare fuzz key and the profile fuzz key as the fuzz family', () => {
    expect(parseRustCacheKey(bare('382b4d60', '96e3044c'))).toEqual({
      generation: 'bare',
      family: 'fuzz',
      os: 'Linux',
      arch: 'x64',
      environment: '382b4d60',
    });
    expect(parseRustCacheKey(profile)).toMatchObject({ generation: 'profile', family: 'fuzz' });
  });

  test.each([
    'v0-rust-workspace-Linux-x64-382b4d60-96e3044c',
    'v0-rust-fuzz-Linux-x64-382b4d60',
    'v0-rust-fuzz-Linux-x64-382B4D60-96e3044c',
    'v0-rust-fuzz-extra-Linux-x64-382b4d60-96e3044c',
  ])('does not read %p as a Rust cache key', (key) => {
    expect(parseRustCacheKey(key)).toBeUndefined();
  });

  test('retires every bare fuzz key once a profile fuzz entry exists, whatever its environment', () => {
    const olds = [
      entry(bare('31d23444', '072a1532'), 14 * 24 * HOUR, { version: archive }),
      entry(bare('382b4d60', '96e3044c'), 9 * 24 * HOUR, { version: archive }),
      entry(bare('c730b669', '96e3044c'), 13 * 24 * HOUR, { version: archive }),
    ];
    const successor = entry(profile, 2 * HOUR, { version: archive });
    expect(
      selectRustCacheDeletions([...olds, successor])
        .map((plan) => plan.entry.id)
        .sort()
    ).toEqual(olds.map((old) => old.id).sort());
    // Until the first profile fuzz entry is saved the bare ones are the only fuzz caches.
    expect(selectRustCacheDeletions(olds)).toEqual([]);
  });

  test('keeps a bare fuzz key when the profile successor has another archive version', () => {
    const old = entry(bare('31d23444', '072a1532'), 14 * 24 * HOUR, { version: archive });
    const successor = entry(profile, 2 * HOUR, { version: 'e'.repeat(64) });
    expect(selectRustCacheDeletions([old, successor])).toEqual([]);
  });
});

describe('cleanup plan', () => {
  test('caps the retention deletions per run, oldest first, and keeps every Rust deletion', () => {
    const backlog = Array.from({ length: 40 }, (_, i) =>
      entry(timingsKey(9000 - i), (i + 1) * 24 * HOUR)
    );
    const all = selectCacheDeletions(backlog, NOW);
    expect(all).toHaveLength(37);
    const capped = planCacheDeletions(backlog, NOW);
    expect(capped).toHaveLength(RETENTION_DELETIONS_PER_RUN);
    expect(capped.map((plan) => plan.entry.id)).toEqual(
      all.slice(0, RETENTION_DELETIONS_PER_RUN).map((plan) => plan.entry.id)
    );
    // Oldest first: the 40th entry goes before the 14th.
    expect(capped[0].entry.id).toBe(backlog[39].id);
  });

  test('plans nothing for a listing that already holds only the newest entries', () => {
    expect(planCacheDeletions(turboRuns(3), NOW)).toEqual([]);
  });
});

const MAIN_RUN: CacheWriterRun = {
  id: 42,
  path: '.github/workflows/ci.yml',
  event: 'push',
  status: 'completed',
  head_branch: 'main',
  head_repository: { full_name: REPOSITORY },
};

/** A recorded retry runtime: waits are noted, never slept. */
function inertRetry(): GitHubRetry {
  return new GitHubRetry(STANDARD_RETRY_POLICY, new RecordedRetryEnvironment());
}

/** FakeRetentionCacheApi: an in-memory main listing with scripted writers and snapshots. */
class FakeRetentionCacheApi implements RustCacheApi {
  snapshots: RustCacheEntry[][] = [];
  writers: CacheWriterRun[] = [];
  deletedIds: number[] = [];
  constructor(public entries: RustCacheEntry[]) {}

  getRun(_id: number): Promise<CacheWriterRun> {
    return Promise.resolve(MAIN_RUN);
  }
  listCaches(): Promise<RustCacheEntry[]> {
    return Promise.resolve(this.snapshots.shift() ?? [...this.entries]);
  }
  activeWriters(): Promise<CacheWriterRun[]> {
    return Promise.resolve(this.writers);
  }
  deleteCache(id: number): Promise<boolean> {
    this.deletedIds.push(id);
    this.entries = this.entries.filter((candidate) => candidate.id !== id);
    return Promise.resolve(true);
  }
}

const run = (api: RustCacheApi, apply = true) =>
  cleanupRustCaches(api, {
    repository: REPOSITORY,
    runId: 42,
    apply,
    retry: inertRetry(),
    now: () => NOW,
  });

describe('cleanup with the retention rule', () => {
  test('deletes the entries beyond the newest three and leaves the newest untouched', async () => {
    const runs = turboRuns(5);
    const api = new FakeRetentionCacheApi(runs);
    const result = await run(api);
    expect(result.deferred).toBeNull();
    expect(result.deletedIds).toEqual([runs[4].id, runs[3].id]);
    expect(api.entries.map((kept) => kept.id)).toEqual(runs.slice(0, 3).map((kept) => kept.id));
  });

  test('a dry run plans the deletions and deletes nothing', async () => {
    const api = new FakeRetentionCacheApi(turboRuns(5));
    const result = await run(api, false);
    expect(result.planned).toHaveLength(2);
    expect(api.deletedIds).toEqual([]);
  });

  test('defers while a main writer is active, like the Rust rule', async () => {
    const api = new FakeRetentionCacheApi(turboRuns(5));
    api.writers = [{ ...MAIN_RUN, id: 43, status: 'in_progress' }];
    const result = await run(api);
    expect(result.deferred).toContain('43');
    expect(api.deletedIds).toEqual([]);
  });

  test('defers when a new save changes the newest entry between plan and delete', async () => {
    const runs = turboRuns(5);
    const newest = entry(turboKey('build', 9999), 2 * HOUR);
    const api = new FakeRetentionCacheApi(runs);
    api.snapshots = [runs, [newest, ...runs]];
    const result = await run(api);
    expect(result.deferred).toContain('changed or disappeared');
    expect(api.deletedIds).toEqual([]);
  });

  test('an unrecognised key in a named family fails the run before any deletion', async () => {
    const bad = entry('Linux-X64-v1-timings-main-test-shard-two-1', 24 * HOUR);
    const api = new FakeRetentionCacheApi([...turboRuns(5), bad]);
    await expect(run(api)).rejects.toThrow(
      'Unrecognised cache key "Linux-X64-v1-timings-main-test-shard-two-1"'
    );
    expect(api.deletedIds, 'expected no deletion after a failed plan').toEqual([]);
  });

  test('an unrecognised key that appears after planning stops the run before the next deletion', async () => {
    const runs = turboRuns(5);
    const bad = entry('Linux-X64-v1-lint-tools-main-nothex', 24 * HOUR);
    const api = new FakeRetentionCacheApi(runs);
    api.snapshots = [runs, [...runs, bad]];
    await expect(run(api)).rejects.toThrow(
      'Unrecognised cache key "Linux-X64-v1-lint-tools-main-nothex"'
    );
    expect(api.deletedIds).toEqual([]);
  });

  test('pull request caches on other refs never reach the DELETE', async () => {
    const pullRequestCopies = turboRuns(6).map((copy) => ({
      ...copy,
      id: copy.id + 1,
      ref: 'refs/pull/7/merge',
    }));
    const api = new FakeRetentionCacheApi(pullRequestCopies);
    const result = await run(api);
    expect(result.planned).toEqual([]);
    expect(api.deletedIds).toEqual([]);
  });
});

describe('fixture clock', () => {
  test('uses the real time without --now and the pinned time with it', () => {
    const before = Date.now();
    const real = parseFixtureClock(['--fixture', 'listing.json']);
    expect(real).toBeGreaterThanOrEqual(before);
    expect(real).toBeLessThanOrEqual(Date.now());
    expect(parseFixtureClock(['--fixture', 'listing.json', '--now', '2026-11-28T06:00:00Z'])).toBe(
      NOW
    );
  });

  test('rejects a timestamp and an argument shape it cannot read', () => {
    expect(() => parseFixtureClock(['--fixture', 'l.json', '--now', 'tomorrow'])).toThrow(
      'Invalid --now "tomorrow"; expected an ISO 8601 timestamp'
    );
    expect(() => parseFixtureClock(['--fixture', 'l.json', '--then', 'x'])).toThrow(
      'expected --fixture <listing.json> [--now <ISO 8601 timestamp>]'
    );
    expect(() => parseFixtureClock(['--fixture'])).toThrow('expected --fixture <listing.json>');
  });

  test('the fixture mode of the script prints the plan for the pinned clock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mango-retention-fixture-'));
    try {
      const path = join(dir, 'listing.json');
      writeFileSync(path, JSON.stringify({ actions_caches: turboRuns(5) }));
      const result = Bun.spawnSync({
        cmd: [
          'bun',
          'scripts/ci/rust-cache-cleanup.ts',
          '--fixture',
          path,
          '--now',
          '2026-11-28T06:00:00Z',
        ],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.stderr.toString()).toBe('');
      expect(result.exitCode).toBe(0);
      const plan = JSON.parse(result.stdout.toString()) as Array<{ entry: RustCacheEntry }>;
      expect(plan).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('workflow contract of the retained families', () => {
  const calls = (file: string): string[] =>
    readText(file)
      .split(/^ {6}- /m)
      .filter((step) => step.includes('cache-scoped'));
  const field = (step: string, name: string): string | undefined =>
    new RegExp(`^ {10}${name}: (.+)$`, 'm').exec(step)?.[1].replaceAll('"', '');

  test('turbo lanes and the timings lane are the restore prefixes the workflows pass', () => {
    const prefixes = (file: string, family: string): Array<string | undefined> =>
      calls(file)
        .filter((step) => field(step, 'family') === family && field(step, 'mode') === 'restore')
        .map((step) => field(step, 'restore-prefix'));
    expect(prefixes('.github/workflows/build.yml', 'turbo')).toEqual(['build-']);
    expect(prefixes('.github/workflows/lint.yml', 'turbo')).toEqual(['check-']);
    expect(prefixes('.github/workflows/ci.yml', 'timings')).toEqual(['test-']);
  });

  test('each retained family still has a main-scope writer', () => {
    const writers = [
      '.github/workflows/build.yml',
      '.github/workflows/lint.yml',
      '.github/workflows/test.yml',
    ].flatMap(calls);
    for (const { family } of RETENTION_RULES) {
      expect(
        writers.some((step) => field(step, 'family') === family),
        `expected a cache-scoped call for family ${family} in build.yml, lint.yml or test.yml`
      ).toBe(true);
    }
  });
});
