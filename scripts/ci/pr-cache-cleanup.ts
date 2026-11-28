#!/usr/bin/env bun
// Delete the Actions caches a pull request left on refs/pull/<N>/merge. Only
// that pull request can restore them, so once it closes they are dead weight.
//
//   bun ./scripts/ci/pr-cache-cleanup.ts --pr 2222             # dry run
//   bun ./scripts/ci/pr-cache-cleanup.ts --pr 2222 --delete
//   bun ./scripts/ci/pr-cache-cleanup.ts --all-closed          # dry run: backlog sweep
//   bun ./scripts/ci/pr-cache-cleanup.ts --all-closed --delete
//
// Dry run is the default everywhere; only --delete mutates. Reads
// GITHUB_REPOSITORY and GITHUB_TOKEN (actions: write to delete).

import { appendFileSync } from 'node:fs';

import { GitHubRetry } from '../lib/github-retry';
import {
  cleanupPullRequestCaches,
  formatPullRequestCacheReport,
  type PullRequestCacheCleanupResult,
  sweepClosedPullRequestCaches,
} from './pr-cache/cleanup';
import { GithubPullRequestCacheApi } from './pr-cache/github';
import { parsePullRequestNumber } from './pr-cache/selection';

export type PullRequestCacheCommand =
  | { readonly kind: 'pull-request'; readonly pullRequest: number; readonly apply: boolean }
  | { readonly kind: 'all-closed'; readonly apply: boolean };

const USAGE = '--pr <number> [--delete] | --all-closed [--delete]';

/**
 * Parse the command line. The pull request number is validated before any
 * network access; every other argument shape is refused.
 * @example parsePullRequestCacheArguments(['--pr', '2222', '--delete']);
 */
export function parsePullRequestCacheArguments(args: readonly string[]): PullRequestCacheCommand {
  const apply = args.includes('--delete');
  const rest = args.filter((arg) => arg !== '--delete');
  if (rest.length === 1 && rest[0] === '--all-closed') return { kind: 'all-closed', apply };
  if (rest.length === 2 && rest[0] === '--pr') {
    return { kind: 'pull-request', pullRequest: parsePullRequestNumber(rest[1]), apply };
  }
  throw new Error(`Invalid arguments ${JSON.stringify(args)}; expected ${USAGE}`);
}

function summary(result: PullRequestCacheCleanupResult): string {
  return `### Pull request cache cleanup\n\n\`\`\`\n${formatPullRequestCacheReport(result)}\n\`\`\`\n`;
}

async function main(): Promise<void> {
  const command = parsePullRequestCacheArguments(Bun.argv.slice(2));
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository)
    throw new Error(`Invalid GITHUB_REPOSITORY ${JSON.stringify(repository)}; expected owner/repo`);
  // One runtime for the API client and the cleanup: they spend a single wait budget.
  const retry = new GitHubRetry();
  const api = new GithubPullRequestCacheApi(
    repository,
    process.env.GITHUB_TOKEN ?? '',
    undefined,
    retry
  );
  const result =
    command.kind === 'all-closed'
      ? await sweepClosedPullRequestCaches(api, { apply: command.apply, retry })
      : await cleanupPullRequestCaches(api, command.pullRequest, { apply: command.apply, retry });
  console.log(formatPullRequestCacheReport(result));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(result));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
