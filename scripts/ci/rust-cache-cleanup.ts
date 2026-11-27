#!/usr/bin/env bun
// Dependency-free trusted-main tooling. A fixture invocation is read-only:
// bun ./scripts/ci/rust-cache-cleanup.ts --fixture scripts/tests/fixtures/rust-cache-listing.json
// The workflow opts into deletion with --delete and a workflow_run context.

import { appendFileSync, readFileSync } from 'node:fs';

import { parseCacheEntry, record } from './actions-api/client';
import { cleanupRustCaches } from './rust-cache/cleanup';
import { MAIN_CACHE_REF } from './rust-cache/families';
import { GithubRustCacheApi } from './rust-cache/github';
import { type RustCacheEntry, selectRustCacheDeletions } from './rust-cache/selection';

/**
 * Require the workflow_run event and trusted main execution before mutation.
 * @example readCleanupContext(process.env, event);
 */
export function readCleanupContext(
  env: NodeJS.ProcessEnv,
  event: unknown
): { readonly repository: string; readonly runId: number } {
  if (env.GITHUB_EVENT_NAME !== 'workflow_run' || env.GITHUB_REF !== MAIN_CACHE_REF) {
    throw new Error(
      `Invalid cleanup execution ${env.GITHUB_EVENT_NAME} ${env.GITHUB_REF}; expected workflow_run on ${MAIN_CACHE_REF}`
    );
  }
  if (!env.GITHUB_REPOSITORY)
    throw new Error(
      `Invalid GITHUB_REPOSITORY ${JSON.stringify(env.GITHUB_REPOSITORY)}; expected owner/repo`
    );
  const runId = (event as { workflow_run?: { id?: unknown } } | null)?.workflow_run?.id;
  if (!Number.isSafeInteger(runId) || Number(runId) < 1) {
    throw new Error(
      `Invalid workflow_run.id ${JSON.stringify(runId)}; expected a positive integer`
    );
  }
  return { repository: env.GITHUB_REPOSITORY, runId: Number(runId) };
}

/**
 * Read a captured `GET /actions/caches` listing, applying the entry check the
 * live listing uses. A wrong shape fails naming the file instead of reaching
 * the selection as a crash (`entries.map is not a function`) or as a plan
 * over entries it cannot judge.
 * @example readFixtureListing('scripts/tests/fixtures/rust-cache-listing.json');
 */
export function readFixtureListing(path: string): RustCacheEntry[] {
  const expected = '{"actions_caches": [<cache entry>, ...]}';
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Cannot read fixture ${path}: ${error instanceof Error ? error.message : String(error)}; expected ${expected}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Invalid fixture ${path}: expected ${expected} | received invalid JSON ${JSON.stringify(text.slice(0, 80))}`
    );
  }
  const entries = record(parsed) ? parsed.actions_caches : undefined;
  if (!Array.isArray(entries)) {
    throw new Error(
      `Invalid fixture ${path}: expected ${expected} | received ${JSON.stringify(parsed)?.slice(0, 80)}`
    );
  }
  return entries.map((entry, index) => {
    try {
      return parseCacheEntry(entry);
    } catch (error) {
      throw new Error(
        `Invalid fixture ${path} at actions_caches[${index}]: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);
  if (args.length === 2 && args[0] === '--fixture') {
    console.log(JSON.stringify(selectRustCacheDeletions(readFixtureListing(args[1])), null, 2));
    return;
  }
  if (args.length !== 1 || !['--delete', '--dry-run'].includes(args[0])) {
    throw new Error(
      `Invalid arguments ${JSON.stringify(args)}; expected --fixture <listing.json>, --dry-run or --delete`
    );
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath)
    throw new Error(
      `Invalid GITHUB_EVENT_PATH ${JSON.stringify(eventPath)}; expected an event JSON path`
    );
  const event: unknown = JSON.parse(readFileSync(eventPath, 'utf8'));
  const context = readCleanupContext(process.env, event);
  const api = new GithubRustCacheApi(context.repository, process.env.GITHUB_TOKEN ?? '');
  const result = await cleanupRustCaches(api, { ...context, apply: args[0] === '--delete' });
  console.log(JSON.stringify(result, null, 2));
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const bytes = result.planned
    .filter(({ entry }) => result.deletedIds.includes(entry.id))
    .reduce((sum, { entry }) => sum + entry.size_in_bytes, 0);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Rust cache cleanup\n\nDeleted ${result.deletedIds.length} superseded entries, ${bytes} bytes.\n\n${result.deferred ?? 'Every selected family retains its committed replacement.'}\n`
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
