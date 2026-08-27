import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  AddWorktreeBody,
  GitWorktree,
  GitWorktreeListResponse,
  RemoveWorktreeBody,
} from '@mangostudio/shared/git';
import { getRuntimeClient } from '../../../services/runtime-client';
import { resolveGitCommonDir } from '../domain/git-common-dir';
import {
  buildWorktreeAddArgs,
  buildWorktreeRemoveArgs,
  GitWorktreeArgumentError,
} from '../domain/worktree-command';
import { parseWorktreeList } from '../domain/worktree-parser';
import {
  findWorktree,
  isSameWorktreePath,
  type WorktreePathSemantics,
} from '../domain/worktree-selection';
import { GitCliError, type GitRuntimeSelection, runGit } from '../infrastructure/git-cli';
import { type GitInvalidationTarget, publishGitWriteInvalidation } from './git-realtime-service';
import {
  combinedCommandOutput,
  commandDetail,
  GitWriteError,
  mapWriteFailure,
  requireRepoRoot,
  withMutationLock,
} from './git-write-service';

// Adding a worktree checks out a whole tree, so it gets the same headroom a
// commit gets rather than the default read timeout.
const WORKTREE_CHECKOUT_TIMEOUT_MS = 60_000;

type WorktreeMutation = 'worktreeAdd' | 'worktreeRemove';

/**
 * Every worktree of one repository, as Git lists them.
 *
 * @example
 * await listWorktrees('/repo/src', signal, selection); // { worktrees: [...] }
 */
export async function listWorktrees(
  workdir: string,
  signal?: AbortSignal,
  selection?: GitRuntimeSelection
): Promise<GitWorktreeListResponse> {
  try {
    const root = await requireRepoRoot(workdir, signal, selection);
    return await readWorktreeList(root, signal, selection);
  } catch (error) {
    return mapWorktreeFailure(error, 'Listing worktrees');
  }
}

/**
 * Creates a worktree at `path`, either checking out an existing branch or
 * creating one, and answers with the refreshed list.
 *
 * @example
 * await addWorktree('/repo', { path: '/wt/x', mode: 'new-branch', branch: 'feat/x' }, target);
 */
export function addWorktree(
  workdir: string,
  input: Pick<AddWorktreeBody, 'path' | 'mode' | 'branch'>,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitWorktreeListResponse> {
  return runWorktreeMutation(
    workdir,
    invalidationTarget,
    signal,
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
 * @example
 * await removeWorktree('/repo', { path: '/wt/x', force: true }, target);
 */
export function removeWorktree(
  workdir: string,
  input: Pick<RemoveWorktreeBody, 'path' | 'force'>,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitWorktreeListResponse> {
  return runWorktreeMutation(
    workdir,
    invalidationTarget,
    signal,
    'Removing worktree',
    'worktreeRemove',
    async (root, selection, paths) => {
      const { worktrees } = await readWorktreeList(root, signal, selection);
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
      refuseUnremovableWorktree(worktree, root, paths);
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
 * The three removals this API refuses outright, before Git is asked.
 *
 * Removing the main worktree is impossible — Git refuses it too, but saying so
 * in the API's own words beats surfacing a `fatal:`. Removing the worktree the
 * calling chat is bound to would delete the directory the chat is working in
 * and leave every later request in this panel pointing at nothing. A locked
 * worktree is locked for a reason its author wrote down, so the reason is
 * surfaced and the caller is sent to unlock it rather than being offered an
 * escalation to the `-f -f` that would override it.
 *
 * A worktree with uncommitted work is deliberately *not* on this list: Git
 * already refuses it without `--force` and knows far better than a second
 * status read here whether the tree is dirty.
 */
function refuseUnremovableWorktree(
  worktree: GitWorktree,
  root: string,
  paths: WorktreePathSemantics
): void {
  if (worktree.isMain) {
    throw new GitWriteError('The main worktree cannot be removed.', 409, ERROR_CODES.CONFLICT);
  }
  if (isSameWorktreePath(worktree.path, root, paths)) {
    throw new GitWriteError(
      'This chat is working in that worktree. Point it elsewhere before removing it.',
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
 * The lock key is the common directory rather than the repository root, because
 * that is the state `worktree add` and `worktree remove` write: the worktree
 * registry and the ref database, shared by every worktree of the repository.
 * Keyed on the root, a mutation from the main worktree and one from a linked
 * worktree would take different locks and race on the same registry.
 */
async function runWorktreeMutation(
  workdir: string,
  target: GitInvalidationTarget,
  signal: AbortSignal | undefined,
  operation: string,
  invalidationOperation: WorktreeMutation,
  mutation: (
    root: string,
    selection: GitRuntimeSelection,
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
    const commonDir = await readGitCommonDir(root, selection, paths, signal);
    const worktrees = await withMutationLock(target.environmentId, commonDir, async () => {
      await mutation(root, selection, paths);
      return await readWorktreeList(root, signal, selection);
    });
    publishGitWriteInvalidation(target, invalidationOperation);
    return worktrees;
  } catch (error) {
    return mapWorktreeFailure(error, operation);
  }
}

async function readWorktreeList(
  root: string,
  signal?: AbortSignal,
  selection?: GitRuntimeSelection
): Promise<GitWorktreeListResponse> {
  const result = await runGit(['worktree', 'list', '--porcelain', '-z'], {
    cwd: root,
    signal,
    ...selection,
  });
  return { worktrees: parseWorktreeList(result.stdout) };
}

/** How the machine that owns the repository writes and compares its own paths. */
async function readTargetPaths(selection: GitRuntimeSelection): Promise<WorktreePathSemantics> {
  const runtime = await getRuntimeClient(selection.userId, selection.environmentId);
  return runtime.paths;
}

/** The absolute administrative directory every worktree of this repository shares. */
async function readGitCommonDir(
  root: string,
  selection: GitRuntimeSelection,
  paths: WorktreePathSemantics,
  signal?: AbortSignal
): Promise<string> {
  const result = await runGit(['rev-parse', '--git-common-dir'], {
    cwd: root,
    signal,
    ...selection,
  });
  return resolveGitCommonDir(root, result.stdout, paths);
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
