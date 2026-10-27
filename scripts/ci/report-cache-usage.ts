#!/usr/bin/env bun
// Read-only, advisory accounting after the mandatory Gate verdict. Keep this
// script and its imports dependency-free: Gate does not run `bun install`.
import { appendFileSync } from 'node:fs';

import { cacheFamily } from './cache-families';
import {
  BYTES_PER_GB,
  CACHE_PAGE_SIZE,
  type CacheUsageApi,
  GithubCacheUsageApi,
  STORAGE_LIMIT_FIELD,
} from './cache-usage/github';
import { parseRustCacheKey } from './rust-cache/families';

export { cacheFamily } from './cache-families';

export interface CacheEntry {
  readonly id: number;
  readonly key: string;
  readonly sizeInBytes: number;
}

export interface CacheUsage {
  readonly totalBytes: number;
  readonly entryCount: number;
}

export interface CacheInventory {
  readonly entries: readonly CacheEntry[];
  readonly totalBytes: number;
  readonly expectedCount?: number;
  readonly complete: boolean;
  readonly pages: number;
  readonly problems: readonly string[];
}

export interface CacheReport {
  readonly allowanceGb?: number;
  readonly allowanceProblem?: string;
  readonly usage?: CacheUsage;
  readonly usageProblem?: string;
  readonly inventory: CacheInventory;
}

export interface CacheReportLimits {
  readonly requestTimeoutMs: number;
  readonly reportTimeoutMs: number;
  readonly maxPages: number;
}

export const CACHE_REPORT_LIMITS: CacheReportLimits = {
  requestTimeoutMs: 3_000,
  reportTimeoutMs: 15_000,
  maxPages: 50,
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function natural(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Abort real requests and bound adapters that ignore AbortSignal. The race
 * includes response.json(), so a hanging response body is bounded too.
 */
async function boundedRead(
  read: (signal: AbortSignal) => Promise<unknown>,
  started: number,
  limits: CacheReportLimits
): Promise<unknown> {
  const remaining = limits.reportTimeoutMs - (performance.now() - started);
  if (remaining <= 0) throw new Error('Whole-report deadline exceeded');
  const timeout = Math.min(limits.requestTimeoutMs, remaining);
  const wholeDeadline = remaining <= limits.requestTimeoutMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        wholeDeadline ? 'Whole-report deadline exceeded' : 'Per-request deadline exceeded'
      );
      // Reject first so native fetch's AbortError does not obscure the deadline.
      reject(error);
      controller.abort(error);
    }, timeout);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => read(controller.signal)), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function inventory(
  api: CacheUsageApi,
  started: number,
  limits: CacheReportLimits
): Promise<CacheInventory> {
  const entries = new Map<number, CacheEntry>();
  const problems: string[] = [];
  let totalBytes = 0;
  let expectedCount: number | undefined;
  let pages = 0;
  let complete = false;
  try {
    for (let page = 1; page <= limits.maxPages; page++) {
      const body = await boundedRead((signal) => api.listCaches(page, signal), started, limits);
      pages++;
      if (!record(body) || !natural(body.total_count) || !Array.isArray(body.actions_caches)) {
        throw new Error(`Malformed cache page ${page}; expected total_count and actions_caches`);
      }
      if (expectedCount !== undefined && expectedCount !== body.total_count) {
        problems.push(`Listing count changed from ${expectedCount} to ${body.total_count}`);
      }
      expectedCount ??= body.total_count;
      const batch: unknown[] = body.actions_caches;
      if (batch.length > CACHE_PAGE_SIZE) {
        throw new Error(
          `Oversized cache page ${page}; expected at most ${CACHE_PAGE_SIZE} entries`
        );
      }
      for (const [index, raw] of batch.entries()) {
        if (
          !record(raw) ||
          !natural(raw.id) ||
          raw.id === 0 ||
          typeof raw.key !== 'string' ||
          raw.key.length === 0 ||
          !natural(raw.size_in_bytes)
        ) {
          problems.push(`Invalid ID, key or size on page ${page}, entry ${index + 1}`);
          continue;
        }
        if (entries.has(raw.id)) {
          problems.push(`Duplicate cache ID ${raw.id} on page ${page}`);
          continue;
        }
        if (!natural(totalBytes + raw.size_in_bytes)) {
          problems.push(`Listing byte total exceeds the safe integer range on page ${page}`);
          continue;
        }
        entries.set(raw.id, { id: raw.id, key: raw.key, sizeInBytes: raw.size_in_bytes });
        totalBytes += raw.size_in_bytes;
      }
      if (problems.length > 0) break;
      if (entries.size === expectedCount) {
        complete = true;
        break;
      }
      if (entries.size > expectedCount || batch.length < CACHE_PAGE_SIZE) {
        throw new Error(`Incomplete listing: ${entries.size} unique entries of ${expectedCount}`);
      }
      if (page === limits.maxPages) {
        problems.push(`Pagination limit reached (${limits.maxPages} pages)`);
      }
    }
  } catch (caught) {
    problems.push(message(caught));
  }
  return { entries: [...entries.values()], totalBytes, expectedCount, complete, pages, problems };
}

/** Collect independent samples without treating unavailable data as zero. */
export async function collectCacheReport(
  api: CacheUsageApi,
  limits: CacheReportLimits = CACHE_REPORT_LIMITS
): Promise<CacheReport> {
  if (
    [limits.requestTimeoutMs, limits.reportTimeoutMs, limits.maxPages].some(
      (value) => !Number.isSafeInteger(value) || value < 1
    )
  ) {
    throw new Error('Cache report limits must be positive safe integers');
  }
  const started = performance.now();
  const [allowance, usage, listing] = await Promise.all([
    boundedRead((signal) => api.getAllowance(signal), started, limits).then(
      (body) => {
        if (
          !record(body) ||
          !natural(body[STORAGE_LIMIT_FIELD]) ||
          body[STORAGE_LIMIT_FIELD] === 0 ||
          !natural(Number(body[STORAGE_LIMIT_FIELD]) * BYTES_PER_GB)
        ) {
          return {
            allowanceProblem: `Invalid ${STORAGE_LIMIT_FIELD}; expected positive integer GB`,
          };
        }
        return { allowanceGb: Number(body[STORAGE_LIMIT_FIELD]) };
      },
      (caught: unknown) => ({ allowanceProblem: message(caught) })
    ),
    boundedRead((signal) => api.getUsage(signal), started, limits).then(
      (body) => {
        if (
          !record(body) ||
          !natural(body.active_caches_size_in_bytes) ||
          !natural(body.active_caches_count)
        ) {
          return {
            usageProblem: 'Invalid usage sample; expected nonnegative integer bytes and count',
          };
        }
        return {
          usage: {
            totalBytes: body.active_caches_size_in_bytes,
            entryCount: body.active_caches_count,
          },
        };
      },
      (caught: unknown) => ({ usageProblem: message(caught) })
    ),
    inventory(api, started, limits),
  ]);
  return { ...allowance, ...usage, inventory: listing };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function markdown(value: string): string {
  return value
    .replace(/[&<>|`\\]/g, (character) => `&#${character.charCodeAt(0)};`)
    .replace(/\s+/g, ' ');
}

interface EnvironmentRow {
  readonly family: string;
  readonly runner: string;
  readonly environment: string;
  bytes: number;
  count: number;
}

/**
 * Split Rust families that one runner holds under several environment hashes.
 * Light and shipping runtime-build entries differ only in that hash, and so do
 * generations across a toolchain change; the hash alone cannot say which is which.
 *
 * @example environmentRows(entries) // [{ family: 'runtime-build-linux-x64', runner: 'Linux-x64', environment: '1a2b3c4d', bytes, count }]
 */
export function environmentRows(entries: readonly CacheEntry[]): EnvironmentRow[] {
  const rows = new Map<string, EnvironmentRow>();
  for (const entry of entries) {
    const rust = parseRustCacheKey(entry.key);
    if (!rust) continue;
    const runner = `${rust.os}-${rust.arch}`;
    const id = [rust.family, runner, rust.environment].join(':');
    const row = rows.get(id) ?? {
      family: rust.family,
      runner,
      environment: rust.environment,
      bytes: 0,
      count: 0,
    };
    row.bytes += entry.sizeInBytes;
    row.count += 1;
    rows.set(id, row);
  }
  const environments = new Map<string, number>();
  for (const row of rows.values()) {
    const owner = `${row.family}:${row.runner}`;
    environments.set(owner, (environments.get(owner) ?? 0) + 1);
  }
  return [...rows.values()]
    .filter((row) => (environments.get(`${row.family}:${row.runner}`) ?? 0) > 1)
    .sort(
      (a, b) =>
        a.family.localeCompare(b.family) || a.runner.localeCompare(b.runner) || b.bytes - a.bytes
    );
}

/** Full family totals reconcile to the unique entries actually observed. */
export function renderCacheSummary(report: CacheReport): string {
  const { inventory: listing } = report;
  const lines = ['### Actions cache usage', ''];
  if (report.allowanceGb !== undefined) {
    lines.push(
      `Configured allowance: **${report.allowanceGb} GB** from \`GET /repos/{owner}/{repo}/actions/cache/storage-limit\`, \`${STORAGE_LIMIT_FIELD}\` (GB; 1 GB = ${BYTES_PER_GB} bytes).`
    );
  } else {
    lines.push(
      `Configured allowance: **unknown**. ${markdown(report.allowanceProblem ?? 'Unavailable')}.`
    );
  }
  lines.push(
    '',
    `${listing.complete ? 'Complete inventory' : '**Incomplete inventory**'}: ${formatBytes(listing.totalBytes)} (${listing.totalBytes} bytes) across ${listing.entries.length}${listing.expectedCount === undefined ? '' : ` of ${listing.expectedCount}`} unique entries, ${listing.pages} pages.`
  );
  if (report.allowanceGb !== undefined) {
    const share = ((listing.totalBytes / (report.allowanceGb * BYTES_PER_GB)) * 100).toFixed(1);
    lines.push(
      `${listing.complete ? 'Listed' : 'Observed partial'} bytes use ${share}% of the configured allowance.`
    );
  }
  if (listing.problems.length > 0) lines.push('');
  for (const problem of listing.problems) lines.push(`- ${markdown(problem)}`);
  lines.push('');
  if (report.usage) {
    lines.push(
      `Separate usage sample: ${formatBytes(report.usage.totalBytes)} (${report.usage.totalBytes} bytes), ${report.usage.entryCount} entries.`
    );
    if (listing.complete) {
      lines.push(
        `Usage sample minus listing: ${report.usage.totalBytes - listing.totalBytes} bytes, ${report.usage.entryCount - listing.entries.length} entries. Sampling times and concurrent saves/evictions can differ.`
      );
    } else {
      lines.push('Usage sample drift cannot be reconciled against an incomplete inventory.');
    }
  } else {
    lines.push(
      `Separate usage sample: **unknown**. ${markdown(report.usageProblem ?? 'Unavailable')}.`
    );
  }
  lines.push('');
  const byFamily = new Map<string, { bytes: number; count: number }>();
  for (const entry of listing.entries) {
    const family = cacheFamily(entry.key);
    const running = byFamily.get(family) ?? { bytes: 0, count: 0 };
    byFamily.set(family, { bytes: running.bytes + entry.sizeInBytes, count: running.count + 1 });
  }
  lines.push('| Family | Size | Bytes | Entries |', '| --- | ---: | ---: | ---: |');
  for (const [family, totals] of [...byFamily].sort(([, a], [, b]) => b.bytes - a.bytes)) {
    lines.push(`| ${family} | ${formatBytes(totals.bytes)} | ${totals.bytes} | ${totals.count} |`);
  }
  lines.push(
    `| **Total listed** | **${formatBytes(listing.totalBytes)}** | **${listing.totalBytes}** | **${listing.entries.length}** |`,
    ''
  );
  const split = environmentRows(listing.entries);
  if (split.length > 0) {
    lines.push(
      'Rust families held under more than one environment hash on one runner (light and shipping profiles, or a toolchain change):',
      '',
      '| Family | Runner | Environment hash | Size | Bytes | Entries |',
      '| --- | --- | --- | ---: | ---: | ---: |'
    );
    for (const row of split) {
      lines.push(
        `| rust/${row.family} | ${row.runner} | ${row.environment} | ${formatBytes(row.bytes)} | ${row.bytes} | ${row.count} |`
      );
    }
    lines.push('');
  }
  lines.push(
    '<sub>Read-only advisory report. API reads are not atomic. Retained bytes do not measure archive transfer cost or prove cache-write eligibility; billing budgets can reject writes below the configured storage allowance.</sub>',
    ''
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!repository || !token || !summaryPath) {
    console.log('Cache usage reporting needs GITHUB_REPOSITORY, GITHUB_TOKEN and a step summary.');
    return;
  }
  const report = await collectCacheReport(new GithubCacheUsageApi(repository, token));
  appendFileSync(summaryPath, renderCacheSummary(report));
}

if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    console.log(`Skipped advisory cache report: ${message(caught)}`);
  }
}
