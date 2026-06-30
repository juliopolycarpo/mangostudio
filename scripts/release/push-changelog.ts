#!/usr/bin/env bun
// Land the regenerated CHANGELOG.md on the default branch after a release.
//
// Fast path: commit and push directly. A rebase retry absorbs unrelated commits
// that land on the base branch between checkout and push (the concurrent-release
// race). If the push is rejected because the branch is protected, fall back to
// opening a pull request through GitHub's REST API so the changelog still lands
// without a failed release.
//
// The regenerate step (`bun run changelog --release <version>`) runs before this
// script; here we only commit the working-tree change and get it onto the branch.

import { type CaptureResult, captureCommand } from '../lib/exec';
import { error, info, success, warn } from '../lib/log';

const GIT_BOT_NAME = 'github-actions[bot]';
const GIT_BOT_EMAIL = 'github-actions[bot]@users.noreply.github.com';
const CHANGELOG_FILE = 'CHANGELOG.md';
const PULL_REQUESTS_ENDPOINT = 'repos/{owner}/{repo}/pulls';
const PUSH_ATTEMPTS = 3;

const stripLeadingV = (version: string): string => version.replace(/^v/, '');

export interface PushChangelogArgs {
  /** Released version without the leading `v`. */
  readonly version: string;
  /** Default branch the changelog lands on. */
  readonly branch: string;
}

/** Parse the CLI arguments for this script. // Usage: parsePushChangelogArgs(process.argv.slice(2)) */
export function parsePushChangelogArgs(argv: readonly string[]): PushChangelogArgs {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--version', '--branch'].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (value === undefined) {
      throw new Error(`Missing value for ${flag}`);
    }
    values[flag] = value;
    index += 1;
  }

  const version = stripLeadingV(values['--version'] ?? '');
  if (!version) {
    throw new Error('--version is required');
  }
  // The version flows into a branch name and commit message; keep it to the
  // semver-safe character set so a crafted value cannot create an odd ref.
  if (!/^\d[\w.+-]*$/.test(version)) {
    throw new Error(`Invalid --version "${version}". Expected a semver-like value.`);
  }

  return { version, branch: values['--branch'] || 'main' };
}

/** Direct-push commit subject. Carries [skip ci] so a changelog-only push to the
 * default branch does not retrigger CI; the message format GitHub recognizes. */
export const directCommitMessage = (version: string): string =>
  `docs(changelog): update for v${version} [skip ci]`;

/** Pull-request title for the protected-branch fallback. Intentionally omits
 * [skip ci]: the PR's commits must run the branch's required checks for
 * normal review and merge. */
export const pullRequestTitle = (version: string): string =>
  `docs(changelog): update for v${version}`;

/** Short-lived head branch for the fallback pull request. */
export const fallbackBranchName = (version: string): string => `chore/changelog-v${version}`;

/** Body for the fallback pull request. */
export const pullRequestBody = (version: string): string =>
  [
    `Automated changelog update for \`v${version}\`.`,
    '',
    'The release workflow opened this PR because the direct push to the default',
    'branch was rejected by branch protection. Safe to review and squash-merge.',
  ].join('\n');

// Signals git/GitHub emit when a push is refused by branch protection (as
// opposed to a non-fast-forward we can rebase past, or a transient network
// error). Matched case-insensitively against combined stdout+stderr.
const PROTECTION_SIGNALS = [
  'GH006',
  'protected branch',
  'protection',
  'changes must be made through a pull request',
  'pull request is required',
  'required status check',
  'push declined',
] as const;

/** True when a failed push looks like a branch-protection rejection, so the
 * caller should open a pull request instead of retrying the direct push. */
export function isProtectionRejection(output: string): boolean {
  const haystack = output.toLowerCase();
  return PROTECTION_SIGNALS.some((signal) => haystack.includes(signal));
}

export type CommandRunner = (args: readonly string[]) => Promise<CaptureResult>;

/** Build a runner that invokes `command` (optionally in `cwd`) and returns its
 * captured result without throwing, so callers can inspect a non-zero exit. */
export function createRunner(command: string, cwd?: string): CommandRunner {
  return (args) => captureCommand([command, ...args], cwd ? { cwd } : undefined);
}

const combinedOutput = (result: CaptureResult): string =>
  `${result.stderr}\n${result.stdout}`.trim();

export interface LandChangelogOptions {
  readonly version: string;
  readonly baseBranch: string;
  readonly git: CommandRunner;
  readonly gh: CommandRunner;
  readonly remote?: string;
}

export type LandResult = 'up-to-date' | 'pushed' | 'pull-request';

/**
 * Commit the regenerated CHANGELOG.md and land it on `baseBranch`.
 * Returns 'up-to-date' when nothing changed, 'pushed' on a direct push, or
 * 'pull-request' when a protected branch forced the REST PR fallback.
 * // Usage: await landChangelog({ version, baseBranch: 'main', git, gh })
 */
export async function landChangelog(options: LandChangelogOptions): Promise<LandResult> {
  const remote = options.remote ?? 'origin';
  const { version, baseBranch, git, gh } = options;

  const runGit = async (args: readonly string[]): Promise<CaptureResult> => {
    const result = await git(args);
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed (${result.exitCode}): ${combinedOutput(result)}`
      );
    }
    return result;
  };

  // No-op when the changelog is already current (exit 0 == no diff).
  const diff = await git(['diff', '--quiet', '--', CHANGELOG_FILE]);
  if (diff.exitCode === 0) return 'up-to-date';

  await runGit(['config', 'user.name', GIT_BOT_NAME]);
  await runGit(['config', 'user.email', GIT_BOT_EMAIL]);
  // The ephemeral CI checkout has no signing key; never inherit a host policy.
  await runGit(['config', 'commit.gpgsign', 'false']);
  await runGit(['add', '--', CHANGELOG_FILE]);
  await runGit(['commit', '--quiet', '-m', directCommitMessage(version)]);

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
    const push = await git(['push', remote, `HEAD:refs/heads/${baseBranch}`]);
    if (push.exitCode === 0) return 'pushed';

    const output = combinedOutput(push);
    if (isProtectionRejection(output)) {
      return openChangelogPullRequest({ version, baseBranch, remote, runGit, gh });
    }
    if (attempt === PUSH_ATTEMPTS) {
      throw new Error(`Failed to push ${CHANGELOG_FILE} to ${baseBranch}: ${output}`);
    }
    // Non-fast-forward: rebase our commit onto the moved branch and retry.
    await runGit(['pull', '--rebase', remote, baseBranch]);
  }
  throw new Error('unreachable');
}

interface OpenPullRequestOptions {
  readonly version: string;
  readonly baseBranch: string;
  readonly remote: string;
  readonly runGit: CommandRunner;
  readonly gh: CommandRunner;
}

/** Push the changelog commit to a short-lived branch and open (or reuse) a PR. */
async function openChangelogPullRequest(options: OpenPullRequestOptions): Promise<'pull-request'> {
  const { version, baseBranch, remote, runGit, gh } = options;
  const headBranch = fallbackBranchName(version);
  warn(`Direct push to ${baseBranch} was rejected (protected branch); opening a pull request.`);

  // Drop the [skip ci] marker so the PR's required checks run; force-push so a
  // re-run refreshes an existing fallback branch.
  await runGit(['commit', '--amend', '--no-edit', '-m', pullRequestTitle(version)]);
  await runGit(['push', '--force', remote, `HEAD:refs/heads/${headBranch}`]);

  if (!(await hasOpenPullRequest(gh, headBranch, baseBranch))) {
    const create = await gh([
      'api',
      '--method',
      'POST',
      PULL_REQUESTS_ENDPOINT,
      '--raw-field',
      `base=${baseBranch}`,
      '--raw-field',
      `head=${headBranch}`,
      '--raw-field',
      `title=${pullRequestTitle(version)}`,
      '--raw-field',
      `body=${pullRequestBody(version)}`,
      '--jq',
      '.html_url',
    ]);
    if (create.exitCode !== 0) {
      throw new Error(
        [
          `gh api pull request create failed (${create.exitCode}): ${combinedOutput(create)}`,
          'Configure GH_TOKEN with a token that can create pull requests; in CI,',
          'set the CHANGELOG_PR_TOKEN repository secret with Pull requests: write.',
        ].join('\n')
      );
    }
    const url = create.stdout.trim();
    if (url) info(`Opened changelog pull request: ${url}`);
  }

  return 'pull-request';
}

/** Whether an open PR already exists for `headBranch` (idempotent re-runs). */
async function hasOpenPullRequest(
  gh: CommandRunner,
  headBranch: string,
  baseBranch: string
): Promise<boolean> {
  const existing = await gh([
    'api',
    '--paginate',
    '--method',
    'GET',
    PULL_REQUESTS_ENDPOINT,
    '--raw-field',
    'state=open',
    '--raw-field',
    `base=${baseBranch}`,
    '--raw-field',
    'per_page=100',
    '--jq',
    `map(select(.head.ref == "${headBranch}" and .head.repo.full_name == .base.repo.full_name)) | length`,
  ]);
  if (existing.exitCode !== 0) return false;
  // `--paginate` runs the jq per page and concatenates, so sum the per-page
  // counts rather than parsing a single number (a head branch beyond the first
  // page would otherwise be missed and a duplicate PR create attempted).
  const count = existing.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isFinite(value))
    .reduce((total, value) => total + value, 0);
  return count > 0;
}

const printHelp = (): never => {
  console.log(`Usage: bun ./scripts/release/push-changelog.ts --version <version> [--branch <name>]

Lands the regenerated CHANGELOG.md on the default branch (default: main). Tries a
direct push, falling back to a REST-created pull request when the branch is
protected. Requires GH_TOKEN for the fallback. No-ops when nothing changed.`);
  process.exit(0);
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.length === 0) printHelp();

  const args = parsePushChangelogArgs(argv);
  const result = await landChangelog({
    version: args.version,
    baseBranch: args.branch,
    git: createRunner('git'),
    gh: createRunner('gh'),
  });

  switch (result) {
    case 'up-to-date':
      info(`${CHANGELOG_FILE} already up to date.`);
      break;
    case 'pushed':
      success(`Pushed ${CHANGELOG_FILE} update for v${args.version} to ${args.branch}.`);
      break;
    case 'pull-request':
      success(`Opened changelog pull request for v${args.version} into ${args.branch}.`);
      break;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
