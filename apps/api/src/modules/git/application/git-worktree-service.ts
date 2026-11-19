import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  AddWorktreeBody,
  GitWorktree,
  GitWorktreeListResponse,
  RemoveWorktreeBody,
} from '@mangostudio/shared/git';

import { getRuntimeClient } from '../../../services/runtime-client';
import {
  buildWorktreeAddArgs,
  buildWorktreeRemoveArgs,
  GitWorktreeArgumentError,
} from '../domain/worktree-command';
import { parseWorktreeList } from '../domain/worktree-parser';
import { findWorktree, type WorktreePathSemantics } from '../domain/worktree-selection';
import { GitCliError, type GitRuntimeSelection, runGit } from '../infrastructure/git-cli';
import { withRepoMutationLock } from './git-mutation-lock';
import { type GitInvalidationTarget, publishGitWriteInvalidation } from './git-realtime-service';
import {
  combinedCommandOutput,
  commandDetail,
  GitWriteError,
  mapWriteFailure,
  requireRepoRoot,
} from './git-write-service';
import {
  createWorktreeOwnership,
  type OtherChatWorkdirs,
  type WorktreeOwnership,
} from './worktree-ownership';

// Adding a worktree checks out a whole tree, so it gets the same headroom a
// commit gets rather than the default read timeout.
const WORKTREE_CHECKOUT_TIMEOUT_MS = 60_000;

type WorktreeMutation = 'worktreeAdd' | 'worktreeRemove';

/**
 * Every worktree of one repository, as Git lists them, each marked with whether
 * it is the calling chat's own (`isCurrent`) or another chat's (`boundByOtherChat`).
 *
 * `otherChatWorkdirs` is required, here and on the two mutations: every list
 * this module builds carries `boundByOtherChat`, and a caller that skipped it
 * would report every worktree as free to remove.
 *
 * @example
 * await listWorktrees('/repo/src', signal, selection, otherChatWorkdirs); // { worktrees: [...] }
 */
export async function listWorktrees(
  workdir: string,
  signal: AbortSignal | undefined,
  selection: GitRuntimeSelection,
  otherChatWorkdirs: OtherChatWorkdirs
): Promise<GitWorktreeListResponse> {
  try {
    const root = await requireRepoRoot(workdir, signal, selection);
    const ownership = createWorktreeOwnership(
      await readTargetPaths(selection),
      selection,
      otherChatWorkdirs
    );
    return await readWorktreeList(root, ownership, signal, selection);
  } catch (error) {
    return mapWorktreeFailure(error, 'Listing worktrees');
  }
}

/**
 * Creates a worktree at `path`, either checking out an existing branch or
 * creating one, and answers with the refreshed list.
 *
 * @example
 * await addWorktree('/repo', { path: '/wt/x', mode: 'new-branch', branch: 'feat/x' }, target,
 *   signal, otherChatWorkdirs);
 */
export function addWorktree(
  workdir: string,
  input: Pick<AddWorktreeBody, 'path' | 'mode' | 'branch'>,
  invalidationTarget: GitInvalidationTarget,
  signal: AbortSignal | undefined,
  otherChatWorkdirs: OtherChatWorkdirs
): Promise<GitWorktreeListResponse> {
  return runWorktreeMutation(
    workdir,
    invalidationTarget,
    signal,
    otherChatWorkdirs,
    'Adding worktree',
    'worktreeAdd',
    async (root, selection) => {
      // Built before anything runs so a dashed path or branch is refused
      // without Git having created or touched anything.
      const args = buildWorktreeAddArgs(input);
      if (input.mode === 'new-branch') {
        await runGit(['check-ref-format', '--branch', input.branch], {
          cwd: root,
          signal,
          ...selection,
        });
      }
      await runGit(args, {
        cwd: root,
        signal,
        timeoutMs: WORKTREE_CHECKOUT_TIMEOUT_MS,
        ...selection,
      });
    }
  );
}

/**
 * Removes the worktree at `path` and answers with the refreshed list.
 *
 * The refusals read the flags the list reports (`isCurrent`, `boundByOtherChat`)
 * from the very list built here, so a row the panel offers to delete is one the
 * guard lets through for those reasons.
 *
 * There is a window this does not close: a chat can be pointed at the worktree
 * after the list below is read and before `git worktree remove` runs. The
 * repository lock held here serializes Git mutations; it does not cover
 * `updateChatUseCase`, which writes a chat's workdir without touching Git, and
 * taking it there would cost a Git probe (to find the lock's key) and a
 * dependency from chats on the git module on every workdir change, most of
 * which are not in a repository at all. The window is the milliseconds between
 * the read and the removal.
 *
 * @example
 * await removeWorktree('/repo', { path: '/wt/x', force: true }, target, signal, () =>
 *   listOtherChatWorkdirs(userId, environmentId, chatId, db)
 * );
 */
export function removeWorktree(
  workdir: string,
  input: Pick<RemoveWorktreeBody, 'path' | 'force'>,
  invalidationTarget: GitInvalidationTarget,
  signal: AbortSignal | undefined,
  otherChatWorkdirs: OtherChatWorkdirs
): Promise<GitWorktreeListResponse> {
  return runWorktreeMutation(
    workdir,
    invalidationTarget,
    signal,
    otherChatWorkdirs,
    'Removing worktree',
    'worktreeRemove',
    async (root, selection, ownership, paths) => {
      const { worktrees } = await readWorktreeList(root, ownership, signal, selection);
      // The target machine's path semantics, not the hub's: these are paths on
      // that filesystem, and comparing them through `node:path` here would
      // match nothing at all whenever the two platforms disagree. Reused from
      // `runWorktreeMutation`, which already reads them to key the common-dir
      // lock, rather than asking the runtime client a second time.
      const worktree = findWorktree(worktrees, root, input.path, paths);
      if (!worktree) {
        throw new GitWriteError(
          `Worktree was not found: ${input.path}`,
          404,
          ERROR_CODES.NOT_FOUND
        );
      }
      refuseUnremovableWorktree(worktree);
      // Git's own canonical path goes on the command line, not the caller's
      // spelling of it: the entry has already been identified, and re-sending
      // an approximate path would let Git resolve it to a different worktree.
      await runGit(buildWorktreeRemoveArgs({ path: worktree.path, force: input.force }), {
        cwd: root,
        signal,
        ...selection,
      });
    }
  );
}

/**
 * The four removals this API refuses outright, before Git is asked.
 *
 * Removing the main worktree is impossible — Git refuses it too, but saying so
 * in the API's own words beats surfacing a `fatal:`. Removing the worktree the
 * calling chat is bound to would delete the directory the chat is working in
 * and leave every later request in this panel pointing at nothing, and the same
 * holds for a worktree a different chat is bound to: two chats on one
 * repository are the ordinary case, so the check covers every chat bound at or
 * below the worktree, not only the caller. A locked worktree is locked for a
 * reason its author wrote down, so the reason is surfaced and the caller is
 * sent to unlock it rather than being offered an escalation to the `-f -f` that
 * would override it.
 *
 * The current and bound-by-another-chat refusals read the flags the list
 * reports (`isCurrent`, `boundByOtherChat`) instead of comparing paths again, so
 * the panel never offers what this refuses. Main and locked are reported by the
 * same entry (`isMain`, `isLocked`). A row with none of the four set is the
 * only kind this guard lets through; Git may still refuse it (uncommitted work,
 * below).
 *
 * A worktree with uncommitted work is deliberately *not* on this list: Git
 * already refuses it without `--force` and knows far better than a second
 * status read here whether the tree is dirty.
 */
function refuseUnremovableWorktree(worktree: GitWorktree): void {
  if (worktree.isMain) {
    throw new GitWriteError('The main worktree cannot be removed.', 409, ERROR_CODES.CONFLICT);
  }
  if (worktree.isCurrent) {
    throw new GitWriteError(
      'This chat is working in that worktree. Point it elsewhere before removing it.',
      409,
      ERROR_CODES.CONFLICT
    );
  }
  if (worktree.boundByOtherChat) {
    throw new GitWriteError(
      'Another chat is working in that worktree. Point it elsewhere before removing it.',
      409,
      ERROR_CODES.CONFLICT
    );
  }
  if (worktree.isLocked) {
    throw new GitWriteError(
      'The worktree is locked. Unlock it before removing it.',
      409,
      ERROR_CODES.CONFLICT,
      worktree.lockReason
    );
  }
}

/**
 * Runs a worktree mutation under the lock that covers the whole repository.
 *
 * The same lock every other repository mutation takes — `withRepoMutationLock`
 * keys on the common directory, which is exactly the state `worktree add` and
 * `worktree remove` write: the worktree registry and the ref database, shared
 * by every worktree of the repository.
 */
async function runWorktreeMutation(
  workdir: string,
  target: GitInvalidationTarget,
  signal: AbortSignal | undefined,
  otherChatWorkdirs: OtherChatWorkdirs,
  operation: string,
  invalidationOperation: WorktreeMutation,
  mutation: (
    root: string,
    selection: GitRuntimeSelection,
    ownership: WorktreeOwnership,
    paths: WorktreePathSemantics
  ) => Promise<void>
): Promise<GitWorktreeListResponse> {
  const selection: GitRuntimeSelection = target;
  try {
    const root = await requireRepoRoot(workdir, signal, selection);
    // Read once and reused for both the lock key below and whichever mutation
    // needs to compare worktree paths: they are paths on the runtime, not the
    // hub, and every caller of this function is about that same machine.
    const paths = await readTargetPaths(selection);
    const ownership = createWorktreeOwnership(paths, selection, otherChatWorkdirs);
    const worktrees = await withRepoMutationLock(
      selection,
      root,
      async () => {
        await mutation(root, selection, ownership, paths);
        return await readWorktreeList(root, ownership, signal, selection);
      },
      signal
    );
    publishGitWriteInvalidation(target, invalidationOperation);
    return worktrees;
  } catch (error) {
    return mapWorktreeFailure(error, operation);
  }
}

/** `root` is the calling chat's repository root, which is what `isCurrent` is measured against. */
async function readWorktreeList(
  root: string,
  ownership: WorktreeOwnership,
  signal: AbortSignal | undefined,
  selection: GitRuntimeSelection
): Promise<GitWorktreeListResponse> {
  const result = await runGit(['worktree', 'list', '--porcelain', '-z'], {
    cwd: root,
    signal,
    ...selection,
  });
  return { worktrees: await ownership.annotate(parseWorktreeList(result.stdout), root) };
}

/** How the machine that owns the repository writes and compares its own paths. */
async function readTargetPaths(selection: GitRuntimeSelection): Promise<WorktreePathSemantics> {
  const runtime = await getRuntimeClient(selection.userId, selection.environmentId);
  return runtime.paths;
}

function mapWorktreeFailure(error: unknown, operation: string): never {
  if (error instanceof GitWorktreeArgumentError) {
    throw new GitWriteError(
      'A worktree path or branch name must not begin with a dash.',
      422,
      ERROR_CODES.VALIDATION,
      error.value
    );
  }
  if (error instanceof GitCliError) {
    const output = combinedCommandOutput(error);
    if (/contains modified or untracked files/i.test(output)) {
      throw new GitWriteError(
        'The worktree has uncommitted work. Remove it with force to discard that work.',
        409,
        ERROR_CODES.CONFLICT,
        commandDetail(error)
      );
    }
    if (/already used by worktree|is already checked out|already exists/i.test(output)) {
      throw new GitWriteError(
        'That path or branch is already taken by another worktree.',
        409,
        ERROR_CODES.CONFLICT,
        commandDetail(error)
      );
    }
  }
  return mapWriteFailure(error, operation);
}
