/**
 * Which other chats of one user are bound to the directory a GitHub write
 * changed.
 *
 * "The same directory" is the runtime's answer, not a string comparison. A
 * stored workdir is whatever the chat was bound with, and `git rev-parse
 * --show-toplevel` (the checkout root) is whatever Git prints: a symlinked
 * path and its target, or `C:\Repo`, `c:\repo` and `C:/Repo` on a
 * case-folding Windows volume, name one directory without sharing a string
 * (#950). So both sides go through the runtime's `workspace.validate`, the same
 * function that produced a stored workdir, via the resolver the worktree
 * ownership check already uses ({@link createDirectorySpellingResolver}), and
 * are compared by the target's own path rules.
 *
 * Cost, because this runs on every GitHub write:
 *
 * - The database read is one query, and the writer's own chat is excluded in
 *   it. With no other chat bound on that machine nothing is resolved at all.
 * - Each distinct path is resolved once per publish (the resolver dedupes), at
 *   most {@link createDirectorySpellingResolver}'s bound in flight.
 * - A runtime that cannot answer does not lose the fan-out: matching degrades
 *   to the target's lexical rules over the stored strings, which is what it
 *   did before resolution existed.
 *
 * Why not key siblings on the `repo:<key>` topic instead: that key names the
 * whole repository, and a tab that learned it already hears about this write
 * through the repo frame published beside the per-chat one. This enumeration
 * only serves tabs that never learned a key. Deriving a key for each candidate
 * server-side would spawn Git per stored workdir, far dearer than one
 * `canonicalize` per path, and it would also widen the match to other
 * worktrees, which this fan-out deliberately does not reach.
 */

import { getDb } from '../../../db/database';
import { createDiagnosticLogger } from '../../../lib/logger';
import { getRuntimeClient } from '../../../services/runtime-client';
import {
  type ChatWorkdirBinding,
  listOtherChatBindings,
} from '../../chats/infrastructure/chat-repository';
import {
  isSameDirectory,
  isWithinWorktree,
  type PathSpellings,
  type WorktreePathSemantics,
} from '../../git/domain/worktree-selection';
import type { GitRuntimeSelection } from '../../git/infrastructure/git-cli';
import {
  createDirectorySpellingResolver,
  type DirectorySpellingResolver,
} from '../../git/infrastructure/runtime-directories';

const logger = createDiagnosticLogger('github-sibling-chats');

/** The write whose siblings are wanted. */
export interface SiblingTarget {
  readonly userId: string;
  readonly chatId: string;
  readonly environmentId: string;
  readonly workdir: string;
  /** The resolved worktree root; when set, every chat at or under it is a sibling. */
  readonly root?: string;
}

/** The I/O this lookup needs, injected so a test names each fake. */
export interface SiblingChatDependencies {
  readonly listBindings: (
    userId: string,
    environmentId: string,
    excludeChatId: string
  ) => Promise<readonly ChatWorkdirBinding[]>;
  readonly readPaths: (selection: GitRuntimeSelection) => Promise<WorktreePathSemantics>;
  readonly createResolver: (
    selection: GitRuntimeSelection,
    signal?: AbortSignal
  ) => DirectorySpellingResolver;
}

const defaultDependencies: SiblingChatDependencies = {
  listBindings: (userId, environmentId, excludeChatId) =>
    listOtherChatBindings(userId, environmentId, excludeChatId, getDb()),
  readPaths: async (selection) =>
    (await getRuntimeClient(selection.userId, selection.environmentId)).paths,
  createResolver: createDirectorySpellingResolver,
};

/**
 * Ids of the other chats of `target.userId` bound to the written directory: the
 * exact workdir, or anything at or under `target.root` when the write resolved
 * one (`pr checkout` moves the HEAD, index and working tree of the whole
 * checkout, #944; `pr create` and `pr ready` touch one workdir, so two
 * checkouts of one repository stay independent).
 *
 * Rejects when the database or the runtime cannot be reached; the caller owns
 * that failure. An unresolvable single directory does not reject.
 *
 * @example
 * const ids = await findSiblingChatIds({ userId, chatId, environmentId, workdir }, signal);
 */
export async function findSiblingChatIds(
  target: SiblingTarget,
  signal?: AbortSignal,
  dependencies: SiblingChatDependencies = defaultDependencies
): Promise<string[]> {
  const bindings = await dependencies.listBindings(
    target.userId,
    target.environmentId,
    target.chatId
  );
  // Only the writer's chat is bound here: no sibling to find, no round trip.
  if (bindings.length === 0) return [];

  const selection: GitRuntimeSelection = {
    userId: target.userId,
    environmentId: target.environmentId,
  };
  const paths = await dependencies.readPaths(selection);
  const anchor = target.root ?? target.workdir;
  const spellings = await resolveSpellings(
    dependencies.createResolver(selection, signal),
    [anchor, ...bindings.map((binding) => binding.workdir)],
    target.chatId
  );
  const anchorSpellings = spellingsOf(spellings, anchor);
  const matches = target.root
    ? (candidate: PathSpellings) => isWithinWorktree(candidate, anchorSpellings, paths)
    : (candidate: PathSpellings) => isSameDirectory(candidate, anchorSpellings, paths);

  return bindings
    .filter((binding) => matches(spellingsOf(spellings, binding.workdir)))
    .map((binding) => binding.chatId);
}

function spellingsOf(
  resolved: ReadonlyMap<string, PathSpellings>,
  directory: string
): PathSpellings {
  return resolved.get(directory) ?? [directory];
}

/**
 * Resolves every distinct directory once. When the runtime cannot answer, the
 * map is empty and each directory is compared as written: a stale-but-lexical
 * fan-out beats none for a write that already happened.
 */
async function resolveSpellings(
  resolver: DirectorySpellingResolver,
  directories: readonly string[],
  chatId: string
): Promise<ReadonlyMap<string, PathSpellings>> {
  try {
    return await resolver.resolve(directories);
  } catch (error) {
    logger.warn('sibling_resolution_degraded', {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}
