import type { GitWorktree } from '@mangostudio/shared/git';

import type { ParsedWorktree } from '../domain/worktree-parser';
import {
  markBoundByOtherChat,
  markCurrentWorktree,
  type PathSpellings,
  type WorktreePathSemantics,
} from '../domain/worktree-selection';
import type { GitRuntimeSelection } from '../infrastructure/git-cli';
import {
  createDirectorySpellingResolver,
  type DirectorySpellingResolver,
} from '../infrastructure/runtime-directories';

/**
 * Where every *other* chat of this user is bound on this machine, as stored.
 *
 * The git layer holds no database, so the route supplies it. It is required
 * wherever a worktree list is built rather than optional: leaving it out would
 * silently stop reporting, and refusing, the worktrees another chat works in.
 */
export type OtherChatWorkdirs = () => Promise<readonly string[]>;

/** Turns Git's own worktree entries into the entries the API answers with. */
export interface WorktreeOwnership {
  /** `root` is the calling chat's repository root, which `isCurrent` is measured against. */
  annotate(parsed: readonly ParsedWorktree[], root: string): Promise<GitWorktree[]>;
}

/**
 * Builds the annotator for one request.
 *
 * It stamps the two facts that depend on who is asking: `isCurrent` (the calling
 * chat's own worktree) and `boundByOtherChat` (a sibling chat works there). The
 * removal guard refuses on exactly these flags, so the list a panel renders and
 * the 409 a delete earns are computed by one function and cannot disagree.
 *
 * The sibling workdirs and the worktree paths are read and resolved once per
 * request and reused by every list the request builds (a removal reads the list
 * twice, the second inside the repository lock). `signal` is the request's:
 * aborting it stops the pending lookups instead of leaving them to hold that lock.
 *
 * A directory the runtime fails on is compared as written, like one that no
 * longer exists, so a single broken sibling workdir cannot fail the list for
 * every chat on the machine. A runtime that cannot be reached still fails the
 * call, so an add or remove never goes ahead on an ownership answer nobody gave.
 *
 * `boundByOtherChat` is resolved on the runtime, not compared as written. A
 * workdir is stored as the chat was bound with it and Git lists the real path,
 * so a chat bound through a symlinked directory, or under another casing on a
 * case-insensitive volume, names the same directory as a listed worktree without
 * sharing a single string with it.
 *
 * @example
 * const ownership = createWorktreeOwnership(paths, selection, otherChatWorkdirs, request.signal);
 * const worktrees = await ownership.annotate(parseWorktreeList(stdout), root);
 */
export function createWorktreeOwnership(
  paths: WorktreePathSemantics,
  selection: GitRuntimeSelection,
  otherChatWorkdirs: OtherChatWorkdirs,
  signal?: AbortSignal
): WorktreeOwnership {
  // One resolver per request: it remembers every path it has asked the runtime
  // about, so the sibling workdirs and each worktree path are looked up once
  // however many lists the request builds.
  const resolver = createDirectorySpellingResolver(selection, signal);
  let siblings: Promise<readonly PathSpellings[]> | undefined;
  const readSiblings = () => (siblings ??= resolveSiblingSpellings(otherChatWorkdirs, resolver));

  return {
    async annotate(parsed, root) {
      const current = markCurrentWorktree(parsed, root, paths);
      const others = await readSiblings();
      // No other chat, nothing to resolve: the common single-chat case costs no
      // runtime round trip beyond the list itself.
      if (others.length === 0) return markBoundByOtherChat(current, () => [], others, paths);

      const spellings = await resolver.resolve(parsed.map((worktree) => worktree.path));
      return markBoundByOtherChat(
        current,
        (worktreePath) => spellings.get(worktreePath) ?? [worktreePath],
        others,
        paths
      );
    },
  };
}

async function resolveSiblingSpellings(
  otherChatWorkdirs: OtherChatWorkdirs,
  resolver: DirectorySpellingResolver
): Promise<readonly PathSpellings[]> {
  const workdirs = await otherChatWorkdirs();
  const spellings = await resolver.resolve(workdirs);
  return workdirs.map((workdir) => spellings.get(workdir) ?? [workdir]);
}
