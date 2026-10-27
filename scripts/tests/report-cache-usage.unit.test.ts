import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SCOPED_CACHE_FAMILIES } from '../ci/cache-families';
import { type CacheUsageApi, GithubCacheUsageApi } from '../ci/cache-usage/github';
import {
  CACHE_REPORT_LIMITS,
  cacheFamily,
  collectCacheReport,
  environmentRows,
  formatBytes,
  renderCacheSummary,
} from '../ci/report-cache-usage';
import { RUST_CACHE_FAMILIES } from '../ci/rust-cache/families';
import { ROOT_DIR } from '../lib/config';

const scopedKey = (family: string) => `Linux-X64-v1-${family}-main-check-bun-revision`;
const rustKey = (family: string) =>
  `v0-rust-${'a'.repeat(64)}-${family}-Linux-x64-12345678-87654321`;
const cache = (id: number, size = 1024, key = scopedKey('bun')) => ({
  id,
  key,
  size_in_bytes: size,
});
const page = (entries: unknown[], total = entries.length) => ({
  total_count: total,
  actions_caches: entries,
});

/** A named snapshot fake; each page is an independent API read. */
class SnapshotCacheApi implements CacheUsageApi {
  readonly pagesRequested: number[] = [];
  allowance: unknown = { max_cache_size_gb: 35 };
  usage: unknown = { active_caches_size_in_bytes: 0, active_caches_count: 0 };

  constructor(readonly pages: readonly unknown[] = [page([])]) {}

  getAllowance(): Promise<unknown> {
    return this.allowance instanceof Error
      ? Promise.reject(this.allowance)
      : Promise.resolve(this.allowance);
  }

  getUsage(): Promise<unknown> {
    return this.usage instanceof Error ? Promise.reject(this.usage) : Promise.resolve(this.usage);
  }

  listCaches(number: number): Promise<unknown> {
    this.pagesRequested.push(number);
    const result = this.pages[number - 1];
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  }
}

/** Deliberately ignores abort, proving the caller also bounds broken adapters. */
class HangingCacheApi implements CacheUsageApi {
  readonly signals: AbortSignal[] = [];

  private hang(signal: AbortSignal): Promise<unknown> {
    this.signals.push(signal);
    return new Promise(() => {
      // Intentionally never settles or acknowledges abort.
    });
  }

  getAllowance(signal: AbortSignal): Promise<unknown> {
    return this.hang(signal);
  }

  getUsage(signal: AbortSignal): Promise<unknown> {
    return this.hang(signal);
  }

  listCaches(_number: number, signal: AbortSignal): Promise<unknown> {
    return this.hang(signal);
  }
}

describe('exact cache families', () => {
  test('recognizes every scoped and Rust registry entry including hyphenated families', () => {
    for (const family of SCOPED_CACHE_FAMILIES) expect(cacheFamily(scopedKey(family))).toBe(family);
    for (const family of RUST_CACHE_FAMILIES)
      expect(cacheFamily(rustKey(family))).toBe(`rust/${family}`);
    expect(cacheFamily('macOS-ARM64-v2-lint-tools-pr-894-hash')).toBe('lint-tools');
    expect(cacheFamily('Windows-X64-emergency-v3-playwright-run-42-1.64.0')).toBe('playwright');
  });

  test.each([
    'some-other-key',
    'Linux-X64-v1-unregistered-main-key',
    'Linux-X64-v1-turbo-main-bad--validity',
    'unexpected-X64-v1-bun-main-key',
    'Linux-X64-v1-bun-pr-0-key',
    'Linux-X64-v1-bun-main-turbo-main-key',
    'Linux-X64-v1-bun-main-bun-main-key',
    `${rustKey('workspace')}-suffix`,
    rustKey('workspace-extra'),
    'v0-rust-workspace-Linux-x64',
    '<script>|untrusted-family',
  ])('keeps unrelated or malformed key %s in unknown', (key) => {
    expect(cacheFamily(key)).toBe('unknown');
  });
});

describe('complete cache inventory', () => {
  test('fetches more than 100 entries and reconciles every family to unique listing bytes', async () => {
    const entries = Array.from({ length: 152 }, (_, index) =>
      cache(
        index + 1,
        index + 1,
        index < 50
          ? scopedKey('lint-tools')
          : index < 100
            ? rustKey('runtime-build-linux-arm64')
            : 'unregistered-family'
      )
    );
    const api = new SnapshotCacheApi([
      page(entries.slice(0, 100), 152),
      page(entries.slice(100), 152),
    ]);
    api.usage = { active_caches_size_in_bytes: 11_628, active_caches_count: 152 };
    const report = await collectCacheReport(api);
    expect(api.pagesRequested).toEqual([1, 2]);
    expect(report.inventory.complete).toBe(true);
    expect(report.inventory.entries).toHaveLength(152);
    expect(report.inventory.totalBytes).toBe(11_628);
    const summary = renderCacheSummary(report);
    expect(summary).toContain('| lint-tools | 1 KiB | 1275 | 50 |');
    expect(summary).toContain('| rust/runtime-build-linux-arm64 | 4 KiB | 3775 | 50 |');
    expect(summary).toContain('| unknown | 6 KiB | 6578 | 52 |');
    expect(summary).toContain('**11628** | **152**');
    expect(summary).toContain('Usage sample minus listing: 0 bytes, 0 entries');
  });

  test('a Rust family under two environment hashes lists each hash separately', async () => {
    // Light and shipping runtime-build entries share a family and runner and
    // differ only in rust-cache's environment hash.
    const runtime = (environment: string) =>
      `v0-rust-${'a'.repeat(64)}-runtime-build-linux-x64-Linux-x64-${environment}-87654321`;
    const api = new SnapshotCacheApi([
      page([
        cache(1, 300, runtime('11111111')),
        cache(2, 100, runtime('22222222')),
        cache(3, 50, rustKey('workspace')),
      ]),
    ]);
    const summary = renderCacheSummary(await collectCacheReport(api));
    expect(summary).toContain('| rust/runtime-build-linux-x64 | 400 B | 400 | 2 |');
    expect(summary).toContain(
      '| rust/runtime-build-linux-x64 | Linux-x64 | 11111111 | 300 B | 300 | 1 |'
    );
    expect(summary).toContain(
      '| rust/runtime-build-linux-x64 | Linux-x64 | 22222222 | 100 B | 100 | 1 |'
    );
    // One environment needs no breakdown.
    expect(summary).not.toContain('| rust/workspace | Linux-x64 |');
  });

  test('no environment breakdown when every Rust family has one hash', async () => {
    const api = new SnapshotCacheApi([page([cache(1, 50, rustKey('workspace'))])]);
    expect(renderCacheSummary(await collectCacheReport(api))).not.toContain('Environment hash');
  });

  test('one environment per runner is not split even when runners differ', () => {
    const key = (runner: string, environment: string) =>
      `v0-rust-${'a'.repeat(64)}-workspace-${runner}-${environment}-87654321`;
    const entries = [
      { id: 1, key: key('Linux-x64', '11111111'), sizeInBytes: 10 },
      { id: 2, key: key('Windows_NT-x64', '22222222'), sizeInBytes: 20 },
      { id: 3, key: scopedKey('bun'), sizeInBytes: 30 },
    ];
    expect(environmentRows(entries)).toEqual([]);
  });

  test('complete empty inventory is distinct from missing API data', async () => {
    const report = await collectCacheReport(new SnapshotCacheApi());
    expect(report.inventory.complete).toBe(true);
    expect(report.inventory.totalBytes).toBe(0);
    expect(report.inventory.problems).toEqual([]);
  });

  test('usage count and byte drift do not alter the inventory totals', async () => {
    const api = new SnapshotCacheApi([page([cache(1, 100)])]);
    api.usage = { active_caches_size_in_bytes: 200, active_caches_count: 2 };
    const report = await collectCacheReport(api);
    expect(report.inventory.complete).toBe(true);
    expect(report.inventory.totalBytes).toBe(100);
    expect(renderCacheSummary(report)).toContain(
      'Usage sample minus listing: 100 bytes, 1 entries'
    );
  });

  test('duplicate IDs do not inflate partial bytes or fabricate completion', async () => {
    const first = Array.from({ length: 100 }, (_, index) => cache(index + 1));
    const report = await collectCacheReport(
      new SnapshotCacheApi([page(first, 101), page([cache(100, 9000)], 101)])
    );
    expect(report.inventory.complete).toBe(false);
    expect(report.inventory.entries).toHaveLength(100);
    expect(report.inventory.totalBytes).toBe(102_400);
    expect(report.inventory.problems.join(' ')).toContain('Duplicate cache ID 100');
    expect(renderCacheSummary(report)).toContain('Observed partial bytes');
    expect(renderCacheSummary(report)).toContain('drift cannot be reconciled');
  });

  test('changing totals preserve observed entries while declaring the listing incomplete', async () => {
    const first = Array.from({ length: 100 }, (_, index) => cache(index + 1));
    const report = await collectCacheReport(
      new SnapshotCacheApi([page(first, 101), page([cache(101)], 102)])
    );
    expect(report.inventory.entries).toHaveLength(101);
    expect(report.inventory.complete).toBe(false);
    expect(report.inventory.problems).toContain('Listing count changed from 101 to 102');
  });

  test.each([
    [undefined, 'Malformed'],
    [{ total_count: '0', actions_caches: [] }, 'Malformed'],
    [page(Array.from({ length: 101 }, (_, index) => cache(index + 1))), 'Oversized'],
    [page([cache(1)], 2), 'Incomplete listing'],
    [page([cache(1)], 0), 'Incomplete listing'],
    [page([cache(1), cache(1)]), 'Duplicate cache ID'],
    [new Error('GET /caches returned HTTP 429'), 'HTTP 429'],
  ])('rejects malformed, truncated and rate-limited inventory', async (body, reason) => {
    const report = await collectCacheReport(new SnapshotCacheApi([body]));
    expect(report.inventory.complete).toBe(false);
    expect(report.inventory.problems.join(' ')).toContain(String(reason));
  });

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, '10', Number.MAX_SAFE_INTEGER + 1])(
    'invalid cache size %s leaves valid entries intact and cannot poison totals',
    async (size) => {
      const report = await collectCacheReport(
        new SnapshotCacheApi([page([cache(1, 100), { ...cache(2), size_in_bytes: size }])])
      );
      expect(report.inventory.complete).toBe(false);
      expect(report.inventory.totalBytes).toBe(100);
      expect(report.inventory.entries).toHaveLength(1);
    }
  );

  test('zero-byte entries are valid, but sums outside the integer range remain incomplete', async () => {
    const zero = await collectCacheReport(new SnapshotCacheApi([page([cache(1, 0)])]));
    expect(zero.inventory.complete).toBe(true);
    const overflow = await collectCacheReport(
      new SnapshotCacheApi([page([cache(1, Number.MAX_SAFE_INTEGER), cache(2, 1)])])
    );
    expect(overflow.inventory.complete).toBe(false);
    expect(overflow.inventory.totalBytes).toBe(Number.MAX_SAFE_INTEGER);
    expect(overflow.inventory.problems.join(' ')).toContain('safe integer range');
  });

  test('a failed later page retains the completed earlier page', async () => {
    const first = Array.from({ length: 100 }, (_, index) => cache(index + 1));
    const report = await collectCacheReport(
      new SnapshotCacheApi([page(first, 101), new Error('HTTP 403')])
    );
    expect(report.inventory.complete).toBe(false);
    expect(report.inventory.entries).toHaveLength(100);
    expect(report.inventory.problems).toContain('HTTP 403');
  });

  test('bounded pagination ends as incomplete instead of chasing an oversized listing', async () => {
    const first = Array.from({ length: 100 }, (_, index) => cache(index + 1));
    const api = new SnapshotCacheApi([page(first, 101)]);
    const report = await collectCacheReport(api, { ...CACHE_REPORT_LIMITS, maxPages: 1 });
    expect(api.pagesRequested).toEqual([1]);
    expect(report.inventory.complete).toBe(false);
    expect(report.inventory.problems).toContain('Pagination limit reached (1 pages)');
  });
});

describe('allowance and independent usage samples', () => {
  test('35 GB and nondefault limits use the documented source units rather than a binary constant', async () => {
    const api = new SnapshotCacheApi([page([cache(1, 17_500_000_000)])]);
    const summary = renderCacheSummary(await collectCacheReport(api));
    expect(summary).toContain('**35 GB**');
    expect(summary).toContain('max_cache_size_gb');
    expect(summary).toContain('1 GB = 1000000000 bytes');
    expect(summary).toContain('50.0%');
    expect(summary).toContain('16.30 GiB');
    api.allowance = { max_cache_size_gb: 70 };
    expect(renderCacheSummary(await collectCacheReport(api))).toContain('25.0%');
  });

  test.each([
    undefined,
    {},
    { max_cache_size_gb: -1 },
    { max_cache_size_gb: 0 },
    { max_cache_size_gb: '35' },
    { max_cache_size_gb: 35.5 },
    new Error('HTTP 403'),
  ])('unavailable or malformed allowance stays unknown without a default', async (allowance) => {
    const api = new SnapshotCacheApi();
    api.allowance = allowance;
    const report = await collectCacheReport(api);
    expect(report.allowanceGb).toBeUndefined();
    expect(report.inventory.complete).toBe(true);
    const summary = renderCacheSummary(report);
    expect(summary).toContain('Configured allowance: **unknown**');
    expect(summary).not.toContain('%');
    expect(summary).not.toContain('35 GB');
    expect(summary).not.toContain('10 GB');
  });

  test.each([
    {},
    { active_caches_size_in_bytes: -1, active_caches_count: 0 },
    { active_caches_size_in_bytes: 0, active_caches_count: '0' },
    new Error('HTTP 429'),
  ])('invalid usage stays unknown independently of a complete inventory', async (usage) => {
    const api = new SnapshotCacheApi();
    api.usage = usage;
    const report = await collectCacheReport(api);
    expect(report.usage).toBeUndefined();
    expect(report.inventory.complete).toBe(true);
    expect(renderCacheSummary(report)).toContain('Separate usage sample: **unknown**');
  });
});

describe('bounded read-only adapter', () => {
  test('starts without installed packages and exits successfully after a configuration failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cache-report-no-install-'));
    try {
      for (const path of [
        'report-cache-usage.ts',
        'cache-families.ts',
        'cache-usage/github.ts',
        'rust-cache/families.ts',
      ]) {
        const destination = join(directory, path);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(ROOT_DIR, 'scripts/ci', path), destination);
      }
      const process = Bun.spawn([Bun.which('bun') ?? 'bun', './report-cache-usage.ts'], {
        cwd: directory,
        env: {
          GITHUB_REPOSITORY: '../../invalid',
          GITHUB_TOKEN: 'unused-test-token',
          GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = await new Response(process.stdout).text();
      expect(await process.exited).toBe(0);
      expect(output).toContain('Skipped advisory cache report: Invalid GITHUB_REPOSITORY');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('uses the supported GET endpoint and version with a bounded signal, without mutations', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const api = new GithubCacheUsageApi('owner/repo', 'token', (url, init) => {
      requests.push({ url, init });
      return Promise.resolve(
        Response.json(
          url.includes('/storage-limit')
            ? { max_cache_size_gb: 35 }
            : url.includes('/usage')
              ? { active_caches_size_in_bytes: 0, active_caches_count: 0 }
              : page([])
        )
      );
    });
    expect((await collectCacheReport(api)).inventory.complete).toBe(true);
    expect(requests.map(({ url }) => url)).toContain(
      'https://api.github.com/repos/owner/repo/actions/cache/storage-limit'
    );
    expect(requests).toHaveLength(3);
    for (const { init } of requests) {
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init.headers).get('x-github-api-version')).toBe('2026-03-10');
    }
  });

  test('rate-limited requests return advisory problems without retries', async () => {
    let calls = 0;
    const api = new GithubCacheUsageApi('owner/repo', 'token', () => {
      calls++;
      return Promise.resolve(new Response(null, { status: 429 }));
    });
    const report = await collectCacheReport(api);
    expect(calls).toBe(3);
    expect(report.allowanceProblem).toContain('HTTP 429');
    expect(report.usageProblem).toContain('HTTP 429');
    expect(report.inventory.complete).toBe(false);
  });

  test('per-request deadline aborts even when the transport ignores abort', async () => {
    const api = new HangingCacheApi();
    const report = await collectCacheReport(api, {
      requestTimeoutMs: 10,
      reportTimeoutMs: 100,
      maxPages: 2,
    });
    expect(report.inventory.problems).toContain('Per-request deadline exceeded');
    expect(report.allowanceProblem).toBe('Per-request deadline exceeded');
    expect(api.signals.every((signal) => signal.aborted)).toBe(true);
  });

  test('whole-report deadline is shorter than an individual hanging request', async () => {
    const api = new HangingCacheApi();
    const started = performance.now();
    const report = await collectCacheReport(api, {
      requestTimeoutMs: 1000,
      reportTimeoutMs: 10,
      maxPages: 2,
    });
    expect(performance.now() - started).toBeLessThan(500);
    expect(report.inventory.problems).toContain('Whole-report deadline exceeded');
    expect(report.usageProblem).toBe('Whole-report deadline exceeded');
  });

  test('a response with a hanging JSON body is bounded too', async () => {
    const api = new GithubCacheUsageApi('owner/repo', 'token', () =>
      Promise.resolve(new Response(new ReadableStream()))
    );
    const report = await collectCacheReport(api, {
      requestTimeoutMs: 10,
      reportTimeoutMs: 100,
      maxPages: 2,
    });
    expect(report.allowanceProblem).toBe('Per-request deadline exceeded');
    expect(report.inventory.complete).toBe(false);
  });

  test('invalid configuration cannot expand requests or omit deadlines', async () => {
    await expect(
      collectCacheReport(new SnapshotCacheApi(), { ...CACHE_REPORT_LIMITS, maxPages: 0 })
    ).rejects.toThrow('positive safe integers');
    expect(() => new GithubCacheUsageApi('owner/repo?token=secret', 'token')).toThrow('owner/repo');
    expect(() => new GithubCacheUsageApi('owner/repo', '')).toThrow('GITHUB_TOKEN');
  });
});

describe('summary safety and units', () => {
  test('uses binary unit names only for bytes converted on a binary scale', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512 * 1024)).toBe('512 KiB');
    expect(formatBytes(340 * 1024 ** 2)).toBe('340 MiB');
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.50 GiB');
  });

  test('escapes advisory errors and groups untrusted keys without rendering them', async () => {
    const api = new SnapshotCacheApi([page([cache(1, 1024, '|<img>')])]);
    api.allowance = new Error('<img>|unsafe\nnext');
    const summary = renderCacheSummary(await collectCacheReport(api));
    expect(summary).not.toContain('<img>');
    expect(summary).toContain('&#60;img&#62;&#124;unsafe next');
    expect(summary).toContain('| unknown |');
    expect(summary).toContain('billing budgets can reject writes');
  });
});
