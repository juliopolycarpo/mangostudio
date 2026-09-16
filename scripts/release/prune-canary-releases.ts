#!/usr/bin/env bun
// Delete old canary pre-releases, keeping the newest few, and every leftover
// canary draft.
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
  readonly isDraft: boolean;
  readonly createdAt: string;
}

/**
 * The releases to delete, published history first and then every leftover
 * draft.
 *
 * Two rules, because the two shapes cost storage for different reasons. A
 * published per-commit canary is retained by the keep-window, newest first by
 * creation time — and the window is measured over published rows only, so a
 * newer interrupted upload can never evict a build that hubs can still use. A
 * draft is retention-exempt and always deleted: `canary-publish` runs
 * `cancel-in-progress`, and `gh release create` is internally
 * draft → upload → publish, so a superseded run leaves a partial copy of a
 * ~1.1 GB asset set that nothing will ever finish. `publish_release` only
 * clears one when the *same* tag is retried, and a per-commit tag never is.
 *
 * That is safe where this runs — after this job published its own release, in a
 * concurrency group that admits one GitHub canary job — so every draft it can
 * still see belongs to a run that is gone.
 *
 * The draft rule keys on the tag name alone. Only this workflow ever writes
 * that shape, and the name is fixed when the draft is created, whereas
 * `isPrerelease` is set by flags this code does not own.
 *
 * @example
 * selectCanaryReleasesToPrune(entries, 14) // [{ tagName: 'v0.1.1-canary.0a1b2c3', … }, …]
 */
export function selectCanaryReleasesToPrune(
  entries: readonly ReleaseListEntry[],
  keep: number
): readonly ReleaseListEntry[] {
  if (keep < 0) throw new Error(`Keep-window must not be negative, received ${keep}.`);
  const canaries = entries.filter((entry) => PER_COMMIT_CANARY_TAG.test(entry.tagName));
  const newestFirst = (a: ReleaseListEntry, b: ReleaseListEntry) =>
    Date.parse(b.createdAt) - Date.parse(a.createdAt);

  const staleReleases = canaries
    .filter((entry) => !entry.isDraft && entry.isPrerelease)
    .sort(newestFirst)
    .slice(keep);
  const drafts = canaries.filter((entry) => entry.isDraft).sort(newestFirst);

  return [...staleReleases, ...drafts];
}

/**
 * The GitHub CLI call that lists releases for retention.
 *
 * Drafts are listed on purpose: they are half of what this script deletes, and
 * `--exclude-drafts` would hide them. The other `gh release list` call site —
 * the nightly resolver — wants the opposite and keeps the flag, because it
 * resolves the newest canary to smoke-test and a half-uploaded draft is not a
 * published identity.
 *
 * @example
 * listArgs() // ['gh', 'release', 'list', '--limit', '200', '--json', …]
 */
export function listArgs(): string[] {
  return [
    'gh',
    'release',
    'list',
    '--limit',
    '200',
    '--json',
    'tagName,isPrerelease,isDraft,createdAt',
  ];
}

/**
 * The `gh` call that retires one canary release, tag included for a published
 * one.
 *
 * `--cleanup-tag` is what keeps a tag per green commit from accumulating
 * forever. It works only because the `release tags` ruleset excludes
 * `refs/tags/v*-canary.*`; every other `v*` tag is still undeletable, and so is
 * the frozen `v<root>-canary` one, which carries no dot and stays protected.
 * The tag's *name* is burned either way once an immutable release has used it,
 * so deleting it frees the ref, never the name.
 *
 * A draft is deleted without it. A draft's ref may or may not exist — `gh
 * release create` reuses one it finds — and cleaning up a ref that is not there
 * fails the call, which would abort the rest of the prune. An orphan
 * per-commit canary ref costs nothing: its name is already reserved.
 *
 * // Usage: deleteArgs({ tagName: 'v0.1.1-canary.0a1b2c3', isDraft: false })
 */
export function deleteArgs(entry: Pick<ReleaseListEntry, 'tagName' | 'isDraft'>): string[] {
  const base = ['gh', 'release', 'delete', entry.tagName, '--yes'];
  return entry.isDraft ? base : [...base, '--cleanup-tag'];
}

const printHelp = (): never => {
  console.log(`Usage: bun ./scripts/release/prune-canary-releases.ts [flags]

Deletes canary pre-releases older than the newest --keep of them and their tags,
plus every leftover canary draft from an interrupted publish.

Flags:
  --keep <n>   How many canary releases to keep (default: ${DEFAULT_KEEP})
  --dry-run    Print what would be deleted and exit
  --help       Show this help message`);
  process.exit(0);
};

async function listReleases(): Promise<readonly ReleaseListEntry[]> {
  const listed = await captureCommand(listArgs());
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
    success(`No canary release is older than the newest ${keep}, and no draft is left over.`);
    return;
  }

  for (const entry of stale) {
    const label = entry.isDraft ? `${entry.tagName} (draft)` : entry.tagName;
    if (flags['--dry-run']) {
      info(`Would delete ${label}`);
      continue;
    }
    const deleted = await runCommand(`delete ${label}`, deleteArgs(entry));
    if (deleted.exitCode !== 0) {
      throw new Error(`Could not delete the canary release ${entry.tagName}.`);
    }
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
