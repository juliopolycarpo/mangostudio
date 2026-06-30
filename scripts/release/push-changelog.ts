#!/usr/bin/env bun
// Land the regenerated CHANGELOG.md after a release by always opening a pull
// request — never pushing or merging it. This keeps `main` protected without
// fighting branch-protection rejections: the workflow's default GITHUB_TOKEN
// (`ghActions`) writes the commit through GitHub's REST Contents API, which
// produces a GitHub-Verified `github-actions[bot]` commit (no local GPG key
// needed) carrying a DCO `Signed-off-by` trailer. A separate PAT (`ghPr`,
// the `CHANGELOG_PR_TOKEN` repo secret) opens the PR, because GitHub refuses
// to let the built-in Actions token create or approve pull requests.
//
// The regenerate step (`bun run changelog --release <version>`) runs before
// this script; here we only compare, commit (via the API), and open the PR.

import { type CaptureResult, captureCommand } from '../lib/exec';
import { error, info, success } from '../lib/log';

const CHANGELOG_FILE = 'CHANGELOG.md';
const CONTENTS_ENDPOINT = `repos/{owner}/{repo}/contents/${CHANGELOG_FILE}`;
const PULL_REQUESTS_ENDPOINT = 'repos/{owner}/{repo}/pulls';
const REFS_ENDPOINT = 'repos/{owner}/{repo}/git/refs';

// The well-known github-actions[bot] account. Stamping its address on the
// Signed-off-by trailer keeps the DCO trailer consistent with the commit
// author GitHub itself assigns to API commits made with the default token.
const GITHUB_ACTIONS_BOT_NAME = 'github-actions[bot]';
const GITHUB_ACTIONS_BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

const stripLeadingV = (version: string): string => version.replace(/^v/, '');

export interface PushChangelogArgs {
  /** Released version without the leading `v`. */
  readonly version: string;
  /** Default branch the changelog PR targets. */
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

/** Commit subject + DCO trailer for the changelog commit. `chore(release)`
 * matches cliff.toml's existing skip rule, so this commit never re-enters a
 * future changelog. */
export const commitMessage = (version: string): string =>
  [
    `chore(release): update changelog for v${version}`,
    '',
    `Signed-off-by: ${GITHUB_ACTIONS_BOT_NAME} <${GITHUB_ACTIONS_BOT_EMAIL}>`,
  ].join('\n');

/** Pull-request title. Mirrors the commit subject so a squash-merge keeps the
 * same `chore(release)` prefix cliff.toml skips. */
export const pullRequestTitle = (version: string): string =>
  `chore(release): update changelog for v${version}`;

/** Head branch the changelog commit lands on before the PR is opened. */
export const changelogBranchName = (version: string): string => `chore/changelog-v${version}`;

/** Body for the changelog pull request. */
export const pullRequestBody = (version: string): string =>
  [
    `Automated changelog update for \`v${version}\`.`,
    '',
    'The release workflow always opens this PR instead of pushing to the',
    'default branch directly, so the update goes through normal review.',
    'Merge it with a merge commit once checks pass.',
  ].join('\n');

export type CommandRunner = (args: readonly string[]) => Promise<CaptureResult>;

/** Build a runner that invokes `command` and returns its captured result
 * without throwing, so callers can inspect a non-zero exit. `env` lets two
 * runners for the same command (e.g. `gh`) carry different tokens. */
export function createRunner(
  command: string,
  opts?: { cwd?: string; env?: Record<string, string> }
): CommandRunner {
  return (args) => captureCommand([command, ...args], opts);
}

const combinedOutput = (result: CaptureResult): string =>
  `${result.stderr}\n${result.stdout}`.trim();

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const toBase64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const fromBase64 = (content: string): string =>
  Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8');

// Signals GitHub's REST API emits for "ref/file does not exist yet" and "ref
// already exists" respectively, distinguished from other failures (auth,
// network) so the caller knows when to fall back instead of aborting.
const isNotFound = (output: string): boolean => /\b404\b|not found/i.test(output);
const isAlreadyExists = (output: string): boolean =>
  /\b422\b|already exists|unprocessable/i.test(output);

export interface LandChangelogOptions {
  readonly version: string;
  readonly baseBranch: string;
  /** The freshly regenerated CHANGELOG.md contents (read from disk by main()). */
  readonly newChangelog: string;
  /** Default GITHUB_TOKEN: writes the verified commit via the Contents API. */
  readonly ghActions: CommandRunner;
  /** CHANGELOG_PR_TOKEN PAT: the only identity allowed to open the PR. */
  readonly ghPr: CommandRunner;
}

export type LandResult = 'up-to-date' | 'pull-request';

/**
 * Commit the regenerated CHANGELOG.md (via the REST Contents API, so it lands
 * GitHub-Verified) on a fresh `chore/changelog-v<version>` branch and open a
 * pull request for it. Returns 'up-to-date' when nothing changed, or
 * 'pull-request' once the PR exists (created or already open).
 * // Usage: await landChangelog({ version, baseBranch: 'main', newChangelog, ghActions, ghPr })
 */
export async function landChangelog(options: LandChangelogOptions): Promise<LandResult> {
  const { version, baseBranch, newChangelog, ghActions, ghPr } = options;
  const headBranch = changelogBranchName(version);

  const runGh = async (
    gh: CommandRunner,
    args: readonly string[],
    label: string
  ): Promise<CaptureResult> => {
    const result = await gh(args);
    if (result.exitCode !== 0) {
      throw new Error(`gh ${label} failed (${result.exitCode}): ${combinedOutput(result)}`);
    }
    return result;
  };

  const baseRef = await runGh(
    ghActions,
    [
      'api',
      '--method',
      'GET',
      `repos/{owner}/{repo}/git/ref/heads/${baseBranch}`,
      '--jq',
      '.object.sha',
    ],
    `resolve ${baseBranch}`
  );
  const baseSha = baseRef.stdout.trim();

  // Read the current file at the base branch so we can no-op on an unchanged
  // changelog and carry its blob `sha` into the update (the Contents API
  // requires it to overwrite an existing file).
  const existing = await ghActions([
    'api',
    '--method',
    'GET',
    CONTENTS_ENDPOINT,
    '--raw-field',
    `ref=${baseBranch}`,
    '--jq',
    '{sha: .sha, content: .content}',
  ]);
  let existingSha: string | undefined;
  if (existing.exitCode === 0) {
    const parsed = JSON.parse(existing.stdout) as { sha: string; content: string };
    existingSha = parsed.sha;
    if (fromBase64(parsed.content) === newChangelog) return 'up-to-date';
  } else if (!isNotFound(combinedOutput(existing))) {
    throw new Error(
      `Failed to read ${CHANGELOG_FILE} from ${baseBranch}: ${combinedOutput(existing)}`
    );
  }

  await ensureHeadBranch(ghActions, headBranch, baseSha);

  await runGh(
    ghActions,
    [
      'api',
      '--method',
      'PUT',
      CONTENTS_ENDPOINT,
      '--raw-field',
      `message=${commitMessage(version)}`,
      '--raw-field',
      `content=${toBase64(newChangelog)}`,
      '--raw-field',
      `branch=${headBranch}`,
      ...(existingSha ? ['--raw-field', `sha=${existingSha}`] : []),
    ],
    'commit changelog'
  );

  if (!(await hasOpenPullRequest(ghPr, headBranch, baseBranch))) {
    await openPullRequest({ version, baseBranch, headBranch, ghPr });
  }

  return 'pull-request';
}

/** Point `headBranch` at `sha`, creating it if absent and resetting it
 * (force) if it already exists from a prior run — keeping the PR to exactly
 * one commit across re-runs instead of accumulating history. */
async function ensureHeadBranch(gh: CommandRunner, headBranch: string, sha: string): Promise<void> {
  const create = await gh([
    'api',
    '--method',
    'POST',
    REFS_ENDPOINT,
    '--raw-field',
    `ref=refs/heads/${headBranch}`,
    '--raw-field',
    `sha=${sha}`,
  ]);
  if (create.exitCode === 0) return;
  if (!isAlreadyExists(combinedOutput(create))) {
    throw new Error(`Failed to create branch ${headBranch}: ${combinedOutput(create)}`);
  }

  const update = await gh([
    'api',
    '--method',
    'PATCH',
    `${REFS_ENDPOINT}/heads/${headBranch}`,
    '--raw-field',
    `sha=${sha}`,
    '--raw-field',
    'force=true',
  ]);
  if (update.exitCode !== 0) {
    throw new Error(`Failed to reset branch ${headBranch}: ${combinedOutput(update)}`);
  }
}

interface OpenPullRequestOptions {
  readonly version: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly ghPr: CommandRunner;
}

/** Open the changelog pull request. Never merges it — a human reviews and
 * merges with a merge commit. */
async function openPullRequest(options: OpenPullRequestOptions): Promise<void> {
  const { version, baseBranch, headBranch, ghPr } = options;
  const create = await ghPr([
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

Always opens a pull request with the regenerated CHANGELOG.md (default base
branch: main) instead of pushing to it directly. The commit is created through
GitHub's REST Contents API using GH_ACTIONS_TOKEN, so it lands GitHub-Verified
and carries a DCO Signed-off-by trailer; the PR itself is opened with
GH_PR_TOKEN (the CHANGELOG_PR_TOKEN repo secret), since the default Actions
token cannot create pull requests. No-ops when nothing changed.`);
  process.exit(0);
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.length === 0) printHelp();

  const args = parsePushChangelogArgs(argv);
  const newChangelog = await Bun.file(CHANGELOG_FILE).text();

  const result = await landChangelog({
    version: args.version,
    baseBranch: args.branch,
    newChangelog,
    ghActions: createRunner('gh', { env: { GH_TOKEN: requireEnv('GH_ACTIONS_TOKEN') } }),
    ghPr: createRunner('gh', { env: { GH_TOKEN: requireEnv('GH_PR_TOKEN') } }),
  });

  switch (result) {
    case 'up-to-date':
      info(`${CHANGELOG_FILE} already up to date.`);
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
