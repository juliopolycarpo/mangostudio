/**
 * Removal staged as a rename.
 *
 * A skill is a directory, and a partially-removed tree is worse than either
 * outcome: the destination still looks present to a scanner but fails to load.
 * So a removal never walks a tree deleting as it goes. It renames the whole
 * destination to a sibling temp path — one atomic operation — verifies the
 * destination is gone, and only then deletes the temp tree, or renames it back
 * if anything later in the apply fails.
 *
 * This is the staged write in `resource-writer.ts` run backwards, and it buys
 * the same property: rollback is a rename, not a restore from a copy.
 */

import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { LibraryLocationId, StagedRemovalLeftover } from '@mangostudio/shared/library';
import type { LocationDefinition, PathEnv } from '../domain/registry';

export interface TreeRemovalFs {
  lstat(path: string): Promise<Stats | null>;
  readdir(path: string): Promise<Dirent[]>;
  rename(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<Stats>;
}

export const nodeTreeRemovalFs: TreeRemovalFs = {
  async lstat(path) {
    try {
      return await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  readdir: (path) => readdir(path, { withFileTypes: true }),
  rename,
  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
  stat,
};

/**
 * The suffix is what makes two concurrent applies of the same resource unable
 * to collide on one temp path, and the leading dot is what keeps the scanner
 * from ever reporting a staged tree as a resource: it skips dot entries.
 */
const STAGED_SUFFIX = '.removing';

/** Captures the destination basename, which is how a leftover is traced home. */
const STAGED_PATTERN = /^\.(.+)\.[A-Za-z0-9_-]+\.removing$/;

function stagedRemovalPath(resolvedPath: string, suffix: string): string {
  return join(dirname(resolvedPath), `.${basename(resolvedPath)}.${suffix}${STAGED_SUFFIX}`);
}

/**
 * Where staged trees for a location land: beside the destination, which is the
 * location root for the directory layouts and its parent for a `single-file`
 * location, whose own path *is* the destination.
 */
export function stagedRemovalDirectory(location: LocationDefinition, env: PathEnv): string | null {
  const root = location.resolvePath(env);
  if (root === null) return null;
  return location.layout === 'single-file' ? dirname(root) : root;
}

/**
 * Not exported: `removal-apply.ts` recognizes it by `name`, the way it already
 * recognizes `LibraryWriteError`, so the failure code stays a property of the
 * error rather than an import cycle between apply and infrastructure.
 */
class RemovalVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemovalVerificationError';
  }
}

export interface StagedRemoval {
  readonly resolvedPath: string;
  readonly stagePath: string;
  /** Deletes the staged tree. Called once the whole apply is known to have landed. */
  commit(): Promise<void>;
  /** Puts the destination back exactly as it was, by renaming the tree home. */
  rollback(): Promise<void>;
}

/**
 * Moves a destination aside and proves it is gone.
 *
 * Verification is not ceremony: a rename that reports success while the
 * destination still resolves — a stale directory handle, a case-insensitive
 * filesystem collision, a symlink loop — would otherwise be reported to the
 * user as a completed removal of a file that is still there.
 */
export async function stageResourceRemoval(
  input: { readonly resolvedPath: string; readonly suffix: string },
  fs: TreeRemovalFs = nodeTreeRemovalFs
): Promise<StagedRemoval> {
  const stagePath = stagedRemovalPath(input.resolvedPath, input.suffix);
  if (await fs.lstat(stagePath)) {
    throw new RemovalVerificationError(
      `A staged removal already exists at "${stagePath}"; refusing to overwrite it.`
    );
  }

  await fs.rename(input.resolvedPath, stagePath);
  if (await fs.lstat(input.resolvedPath)) {
    // The destination survived its own removal. Put the tree back rather than
    // leaving two copies and reporting success for neither.
    await fs.rename(stagePath, input.resolvedPath).catch(() => undefined);
    throw new RemovalVerificationError(`"${input.resolvedPath}" still exists after being removed.`);
  }

  return {
    resolvedPath: input.resolvedPath,
    stagePath,
    commit: () => fs.remove(stagePath),
    rollback: () => fs.rename(stagePath, input.resolvedPath),
  };
}

/**
 * Staged trees an interrupted apply left behind, newest first.
 *
 * Reported, never swept automatically. A stale temp tree is the accepted cost
 * of never leaving a half-removed skill, and it still holds the only copy of
 * whatever that apply was moving — deleting it on startup would turn a crash
 * into data loss, quietly, at a moment nobody is watching.
 */
export async function findStagedRemovalLeftovers(
  input: { readonly locationId: LibraryLocationId; readonly directory: string },
  fs: TreeRemovalFs = nodeTreeRemovalFs
): Promise<StagedRemovalLeftover[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(input.directory);
  } catch {
    // An absent or unreadable location has no leftovers to report, and is
    // already reported as unreadable by the location probe.
    return [];
  }

  const leftovers = await Promise.all(
    entries
      .filter((entry) => STAGED_PATTERN.test(entry.name))
      .map(async (entry) => {
        const path = join(input.directory, entry.name);
        try {
          return {
            locationId: input.locationId,
            path,
            modifiedAtMs: Math.max(0, Math.round((await fs.stat(path)).mtimeMs)),
          };
        } catch {
          return null;
        }
      })
  );

  return leftovers
    .filter((leftover): leftover is StagedRemovalLeftover => leftover !== null)
    .sort(
      (left, right) => right.modifiedAtMs - left.modifiedAtMs || (left.path < right.path ? -1 : 1)
    );
}

/**
 * Leftovers across several locations, reported once each.
 *
 * Two locations can share a directory — `~/.claude` holds both `CLAUDE.md` and
 * `settings.json` — so a naive fan-out would report the same stale tree twice
 * and make one interrupted removal look like several.
 */
export async function findStagedRemovalsForLocations(
  locations: readonly LocationDefinition[],
  env: PathEnv,
  fs: TreeRemovalFs = nodeTreeRemovalFs
): Promise<StagedRemovalLeftover[]> {
  const scanned = new Map<string, LocationDefinition[]>();
  for (const location of locations) {
    const directory = stagedRemovalDirectory(location, env);
    if (directory === null) continue;
    const sharing = scanned.get(directory);
    if (sharing) sharing.push(location);
    else scanned.set(directory, [location]);
  }

  const found = await Promise.all(
    [...scanned].map(async ([directory, sharing]) => {
      const primary = sharing[0];
      if (primary === undefined) return [];
      const leftovers = await findStagedRemovalLeftovers({ locationId: primary.id, directory }, fs);
      // Scanned once per directory, then attributed per entry: the scan cannot
      // tell which of the locations sharing the directory a staged tree is from.
      return leftovers.map((leftover) => ({
        ...leftover,
        locationId: attributeLeftover(leftover.path, sharing, env, primary.id),
      }));
    })
  );
  return found.flat();
}

/**
 * Which of the locations sharing a directory a staged tree came from.
 *
 * `~/.claude` is the staging directory for both `CLAUDE.md` and `settings.json`,
 * so reporting `.settings.json.a1b2.removing` under whichever location happened
 * to claim the directory first sends `mango doctor` — and the user reading it —
 * to the wrong place. Only a `single-file` location owns a fixed basename, so
 * that is what the staged name is matched against; a directory layout stages its
 * slug directories under a root nothing else shares, and anything unmatched
 * stays with the location that claimed the directory.
 */
function attributeLeftover(
  path: string,
  sharing: readonly LocationDefinition[],
  env: PathEnv,
  fallback: LibraryLocationId
): LibraryLocationId {
  const original = STAGED_PATTERN.exec(basename(path))?.[1];
  if (original === undefined) return fallback;
  for (const candidate of sharing) {
    if (candidate.layout !== 'single-file') continue;
    const root = candidate.resolvePath(env);
    if (root !== null && basename(root) === original) return candidate.id;
  }
  return fallback;
}
