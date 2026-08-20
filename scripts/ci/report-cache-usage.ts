#!/usr/bin/env bun
// Reports how much of the repository's Actions cache budget is in use, and
// which families hold it, into the gate job's step summary.
//
// Tracking Bun's canary channel puts a value that moves several times a day
// (`bun --revision`) into four cache families' primary keys, so every canary
// bump mints new entries instead of refreshing existing ones. That is the
// intended behaviour — a task result produced by one Bun must not be replayed
// as green for another — but it spends the 10 GB budget faster, and GitHub
// evicts least-recently-used entries silently. The families that cannot fall
// back to a loose prefix (playwright, lint-tools) are the ones that hurt when
// evicted, so the pressure is worth seeing rather than inferring from a slow job.
//
// Advisory only: never fails the gate. A missing token or a rate-limited API is
// not a reason to reject a green build.
//
// This file must stay dependency-free (Node built-ins only): the gate job runs
// it straight from a checkout without `bun install`.
// Usage: GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=… bun ./scripts/ci/report-cache-usage.ts

import { appendFileSync } from 'node:fs';

/** GitHub's per-repository Actions cache allowance. */
const CACHE_BUDGET_BYTES = 10 * 1024 ** 3;

/** Families listed with their share, longest first; the rest are summed as "other". */
const FAMILIES_SHOWN = 6;

export interface CacheEntry {
  readonly key: string;
  readonly sizeInBytes: number;
}

export interface CacheUsage {
  readonly totalBytes: number;
  readonly entryCount: number;
}

/**
 * Family segment of a scoped cache key.
 *
 * `cache-scoped` builds `<os>-<arch>-<epoch>-<family>-<scope>-<validity>`, so
 * the family is the fourth segment. A key from anywhere else is reported under
 * its own name rather than guessed at — a wrong attribution reads as a family
 * growing when it is not.
 */
export function cacheFamily(key: string): string {
  const segments = key.split('-');
  return segments.length >= 5 ? (segments[3] ?? key) : key;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Renders the summary block. Pure, so the shape is testable without the API:
 * everything above it is a fetch, and everything below is an append.
 */
export function renderCacheSummary(usage: CacheUsage, entries: readonly CacheEntry[]): string {
  const share = ((usage.totalBytes / CACHE_BUDGET_BYTES) * 100).toFixed(1);
  const lines = [
    '### Actions cache usage',
    '',
    `${formatBytes(usage.totalBytes)} of ${formatBytes(CACHE_BUDGET_BYTES)} (${share}%) across ${usage.entryCount} entries.`,
    '',
  ];

  if (entries.length > 0) {
    const byFamily = new Map<string, { bytes: number; count: number }>();
    for (const entry of entries) {
      const family = cacheFamily(entry.key);
      const running = byFamily.get(family) ?? { bytes: 0, count: 0 };
      byFamily.set(family, { bytes: running.bytes + entry.sizeInBytes, count: running.count + 1 });
    }

    const ranked = [...byFamily].sort(([, a], [, b]) => b.bytes - a.bytes);
    const shown = ranked.slice(0, FAMILIES_SHOWN);
    const rest = ranked.slice(FAMILIES_SHOWN);

    lines.push('| Family | Size | Entries |', '| --- | ---: | ---: |');
    for (const [family, totals] of shown) {
      lines.push(`| ${family} | ${formatBytes(totals.bytes)} | ${totals.count} |`);
    }
    if (rest.length > 0) {
      const bytes = rest.reduce((total, [, totals]) => total + totals.bytes, 0);
      const count = rest.reduce((total, [, totals]) => total + totals.count, 0);
      lines.push(`| other (${rest.length}) | ${formatBytes(bytes)} | ${count} |`);
    }
    lines.push('');
  }

  // Sampled at gate time, after the run's own saves; only the listed page of
  // entries is attributed, so the table can total less than the usage line.
  lines.push('<sub>Sampled when the gate ran. Eviction is least-recently-used.</sub>', '');
  return lines.join('\n');
}

async function githubJson(path: string, token: string): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!repository || !token || !summaryPath) {
    console.log('Cache usage reporting needs GITHUB_REPOSITORY, GITHUB_TOKEN and a step summary.');
    return;
  }

  const usageBody = await githubJson(`/repos/${repository}/actions/cache/usage`, token);
  if (!isRecord(usageBody)) throw new Error('Cache usage response was not an object');
  const usage: CacheUsage = {
    totalBytes: Number(usageBody.active_caches_size_in_bytes ?? 0),
    entryCount: Number(usageBody.active_caches_count ?? 0),
  };

  // One page: enough to rank the families, and the endpoint caps at 100 anyway.
  const listBody = await githubJson(
    `/repos/${repository}/actions/caches?per_page=100&sort=size_in_bytes&direction=desc`,
    token
  );
  const rawEntries =
    isRecord(listBody) && Array.isArray(listBody.actions_caches) ? listBody.actions_caches : [];
  const entries: CacheEntry[] = rawEntries.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.key !== 'string') return [];
    return [{ key: entry.key, sizeInBytes: Number(entry.size_in_bytes ?? 0) }];
  });

  appendFileSync(summaryPath, renderCacheSummary(usage, entries));
}

if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    // Advisory: a failure here says nothing about the change under test.
    console.log(
      `Skipped cache usage report: ${caught instanceof Error ? caught.message : String(caught)}`
    );
  }
}
