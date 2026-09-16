#!/usr/bin/env bun
// Delete old canary pre-releases, keeping the newest few.
//
// Canary cuts one release per green commit — the only shape immutable releases
// allow, since a published release's assets can never be replaced — and each one
// carries every platform archive. Without a keep-window the repository would
// accumulate a full asset set per merge.

import {
  assertNoUnexpectedArguments,
  captureCommand,
  error,
  header,
  info,
  parseArgs,
  runCommand,
  success,
} from '../lib/runner';

/**
 * Default keep-window, measured rather than guessed: one canary release carries
 * 19 assets totalling ~1.1 GB, and `main` takes ~12 commits a week. Fourteen is
 * therefore ~15 GB of release storage and about eight days of history.
 *
 * The window is what a hub's runtime provisioning depends on: a hub fetches its
 * runtime pair from its *own* release, so a build older than the window can no
 * longer provision one and has to upgrade first.
 */
const DEFAULT_KEEP = 14;

/**
 * Per-commit canary tags only: `v<major>.<minor>.<patch>-canary.<sha>`.
 *
 * The legacy rolling `v<root>-canary` tag (no sha) is deliberately unmatched.
 * It is frozen and immutable, older launchers still resolve their assets from
 * it, and its tag name can never be reused anyway.
 */
const PER_COMMIT_CANARY_TAG = /^v\d+\.\d+\.\d+-canary\.g?[0-9a-f]{7,40}$/i;

export interface ReleaseListEntry {
  readonly tagName: string;
  readonly isPrerelease: boolean;
  readonly createdAt: string;
}

/**
 * The tags to delete: every per-commit canary pre-release except the newest
 * `keep`, newest first by creation time.
 *
 * @example
 * selectCanaryReleasesToPrune(entries, 10) // ['v0.1.1-canary.0a1b2c3', …]
 */
export function selectCanaryReleasesToPrune(
  entries: readonly ReleaseListEntry[],
  keep: number
): readonly string[] {
  if (keep < 0) throw new Error(`Keep-window must not be negative, received ${keep}.`);
  return entries
    .filter((entry) => entry.isPrerelease && PER_COMMIT_CANARY_TAG.test(entry.tagName))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(keep)
    .map((entry) => entry.tagName);
}

const printHelp = (): never => {
  console.log(`Usage: bun ./scripts/release/prune-canary-releases.ts [flags]

Deletes canary pre-releases older than the newest --keep of them. Tags are left
in place: the \`release tags\` ruleset refuses deleting a v* tag, and a tag that
carried an immutable release can never be reused regardless.

Flags:
  --keep <n>   How many canary releases to keep (default: ${DEFAULT_KEEP})
  --dry-run    Print what would be deleted and exit
  --help       Show this help message`);
  process.exit(0);
};

async function listReleases(): Promise<readonly ReleaseListEntry[]> {
  const listed = await captureCommand([
    'gh',
    'release',
    'list',
    '--limit',
    '200',
    '--json',
    'tagName,isPrerelease,createdAt',
  ]);
  if (listed.exitCode !== 0) {
    throw new Error(`Could not list the repository releases: ${listed.stderr.trim()}`);
  }
  const parsed: unknown = JSON.parse(listed.stdout);
  if (!Array.isArray(parsed)) throw new Error('gh release list did not answer with an array.');
  return parsed as readonly ReleaseListEntry[];
}

async function main(): Promise<void> {
  const { flags, values, positional } = parseArgs({ valueFlags: ['--keep'] });
  if (flags['--help']) printHelp();
  assertNoUnexpectedArguments(positional);

  const keep = values['--keep'] ? Number.parseInt(values['--keep'], 10) : DEFAULT_KEEP;
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`--keep must be a positive integer, received ${values['--keep']}.`);
  }

  header('Prune canary releases');
  const stale = selectCanaryReleasesToPrune(await listReleases(), keep);
  if (stale.length === 0) {
    success(`No canary release is older than the newest ${keep}.`);
    return;
  }

  for (const tag of stale) {
    if (flags['--dry-run']) {
      info(`Would delete ${tag}`);
      continue;
    }
    // --cleanup-tag=false: the tag outlives its release on purpose. Deleting it
    // is what the `release tags` ruleset refuses, and its name is burned either
    // way once an immutable release has used it.
    const deleted = await runCommand(`delete ${tag}`, [
      'gh',
      'release',
      'delete',
      tag,
      '--yes',
      '--cleanup-tag=false',
    ]);
    if (deleted.exitCode !== 0) throw new Error(`Could not delete the canary release ${tag}.`);
  }
  success(`Pruned ${stale.length} canary release(s), keeping the newest ${keep}.`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
