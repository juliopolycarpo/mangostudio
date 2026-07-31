import type { GitSettings } from '@mangostudio/shared/app-settings';
import { ERROR_CODES, type ErrorCode } from '@mangostudio/shared/errors';
import type {
  CommitBody,
  CommitResponse,
  DeleteBranchBody,
  DiscardPathsBody,
  GitBranchesResponse,
  GitPushBody,
  GitRepoState,
  GitStatus,
  InitRepoResponse,
  RenameBranchBody,
  StagePathsBody,
  StashApplyBody,
  StashDropBody,
  StashListResponse,
  StashPopBody,
  StashSaveBody,
  UnstagePathsBody,
} from '@mangostudio/shared/git';
import {
  parseBranchList,
  parseCheckoutBlockedPaths,
  parseRemoteBranchList,
} from '../domain/branch-parser';
import { buildCommitArgs } from '../domain/commit-command';
import { GitPathValidationError, validateRepoPaths } from '../domain/path-validation';
import { parseStashList } from '../domain/stash-parser';
import {
  GitCliError,
  type GitRuntimeSelection,
  isGitAvailable,
  type RunGitOptions,
  runGit,
} from '../infrastructure/git-cli';
import {
  type GitInvalidationTarget,
  type GitWriteOperation,
  publishGitWriteInvalidation,
} from './git-realtime-service';
import { getRepoRoot, getRepoStatus } from './git-status-service';

type PathSelection = Pick<StagePathsBody | UnstagePathsBody, 'all' | 'paths'>;

const mutationQueues = new Map<string, Promise<void>>();
const COMMIT_TIMEOUT_MS = 60_000;
const REMOTE_TIMEOUT_MS = 120_000;
const MERGE_CONFLICT_PATTERN = /CONFLICT|Merge conflict|needs merge/i;

export class GitWriteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ErrorCode,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'GitWriteError';
  }
}

/** Serializes index mutations for one repository while allowing other repos to proceed. */
async function withMutationLock<T>(
  environmentId: string,
  root: string,
  mutation: () => Promise<T>
): Promise<T> {
  const key = `${environmentId}:${root}`;
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = previous.then(() => current);
  mutationQueues.set(key, queue);

  await previous;
  try {
    return await mutation();
  } finally {
    release();
    if (mutationQueues.get(key) === queue) mutationQueues.delete(key);
  }
}

function runtimeSelection(target: GitInvalidationTarget): GitRuntimeSelection {
  return { userId: target.userId, environmentId: target.environmentId };
}

function runSelectedGit(
  selection: GitRuntimeSelection,
  args: readonly string[],
  options: RunGitOptions
) {
  return runGit(args, { ...options, ...selection });
}

export async function requireRepoRoot(
  workdir: string,
  signal?: AbortSignal,
  selection?: GitRuntimeSelection
): Promise<string> {
  if (!(await isGitAvailable(selection))) {
    throw new GitWriteError('Git is not available on this system.', 409, ERROR_CODES.CONFLICT);
  }
  const root = await getRepoRoot(workdir, signal, selection);
  if (root) return root;
  throw new GitWriteError('Working directory is not a Git repository.', 409, ERROR_CODES.CONFLICT);
}

async function currentRepoState(
  workdir: string,
  root: string,
  selection: GitRuntimeSelection,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return {
    state: 'repo',
    workdir,
    root,
    status: await getRepoStatus(root, signal, selection),
  };
}

function commandDetail(error: GitCliError): string | undefined {
  return error.stderr || error.stdout || undefined;
}

function combinedCommandOutput(error: GitCliError): string {
  return [error.stderr, error.stdout].filter(Boolean).join('\n');
}

export function mapWriteFailure(error: unknown, operation: string): never {
  if (error instanceof GitWriteError) throw error;
  if (error instanceof GitPathValidationError) {
    throw new GitWriteError(
      'Repository paths must stay inside the repository root.',
      422,
      ERROR_CODES.VALIDATION
    );
  }
  if (error instanceof GitCliError) {
    if (/index\.lock|another git process/i.test(combinedCommandOutput(error))) {
      throw new GitWriteError(
        'The Git index is busy. Retry after the other Git operation finishes.',
        409,
        ERROR_CODES.GIT_LOCKED,
        commandDetail(error)
      );
    }
    throw new GitWriteError(
      `${operation} failed.`,
      422,
      ERROR_CODES.GIT_COMMAND_FAILED,
      commandDetail(error)
    );
  }
  throw error;
}

async function hasHead(
  root: string,
  selection: GitRuntimeSelection,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', 'HEAD'], {
      cwd: root,
      signal,
      ...selection,
    });
    return true;
  } catch (error) {
    if (error instanceof GitCliError && error.exitCode === 128) return false;
    throw error;
  }
}

function mapCommitFailure(error: unknown, operation: string): never {
  if (error instanceof GitCliError) {
    const output = combinedCommandOutput(error);
    if (
      /gpg failed|failed to sign|signing failed|couldn't load public key|no private key|ssh-keygen/i.test(
        output
      )
    ) {
      throw new GitWriteError(
        'Git could not sign the commit. Check your configured GPG or SSH signing key.',
        422,
        ERROR_CODES.SIGNING_FAILED,
        commandDetail(error)
      );
    }
    if (/nothing to amend/i.test(output)) {
      throw new GitWriteError(
        'There is no commit to amend.',
        409,
        ERROR_CODES.AMEND_WITHOUT_HEAD,
        commandDetail(error)
      );
    }
    if (/nothing to commit|nothing added to commit|no changes added to commit/i.test(output)) {
      throw new GitWriteError(
        'There are no staged changes to commit.',
        409,
        ERROR_CODES.NOTHING_TO_COMMIT
      );
    }
  }
  return mapWriteFailure(error, operation);
}

/**
 * Resolves the repository root before locking so every workdir that points into
 * the same repository serializes on one key — two chats rooted at `/repo` and
 * `/repo/sub` share a single `.git/index` and must not mutate it concurrently.
 */
async function runRepoMutation<T>(
  workdir: string,
  target: GitInvalidationTarget,
  signal: AbortSignal | undefined,
  operation: string,
  mutation: (root: string) => Promise<T>,
  mapFailure: (error: unknown, operation: string) => never = mapWriteFailure
): Promise<T> {
  try {
    const selection = runtimeSelection(target);
    const root = await requireRepoRoot(workdir, signal, selection);
    return await withMutationLock(target.environmentId, root, () => mutation(root));
  } catch (error) {
    return mapFailure(error, operation);
  }
}

function selectedPaths(root: string, selection: PathSelection): string[] {
  if (selection.all) return [];
  return validateRepoPaths(root, selection.paths ?? []);
}

async function publishAfterSuccessfulMutation<T>(
  invalidationTarget: GitInvalidationTarget,
  operation: GitWriteOperation,
  mutation: Promise<T>
): Promise<T> {
  const result = await mutation;
  publishGitWriteInvalidation(invalidationTarget, operation);
  return result;
}

export function initRepo(
  workdir: string,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<InitRepoResponse> {
  return publishAfterSuccessfulMutation(
    invalidationTarget,
    'init',
    withMutationLock(invalidationTarget.environmentId, workdir, async () => {
      const selection = runtimeSelection(invalidationTarget);
      if (!(await isGitAvailable(selection))) {
        throw new GitCliError(['init'], null, 'Git is not available.');
      }
      await runSelectedGit(selection, ['init'], { cwd: workdir, signal });
      const result = await runSelectedGit(selection, ['rev-parse', '--show-toplevel'], {
        cwd: workdir,
        signal,
      });
      return { root: result.stdout.trim() };
    })
  );
}

export function stagePaths(
  workdir: string,
  selection: PathSelection,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitStatus> {
  return publishAfterSuccessfulMutation(
    invalidationTarget,
    'stage',
    runRepoMutation(workdir, invalidationTarget, signal, 'Staging files', async (root) => {
      const runtime = runtimeSelection(invalidationTarget);
      const paths = selectedPaths(root, selection);
      await runSelectedGit(runtime, selection.all ? ['add', '-A'] : ['add', '--', ...paths], {
        cwd: root,
        signal,
      });
      return await getRepoStatus(root, signal, runtime);
    })
  );
}

export function unstagePaths(
  workdir: string,
  selection: PathSelection,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitStatus> {
  return publishAfterSuccessfulMutation(
    invalidationTarget,
    'unstage',
    runRepoMutation(workdir, invalidationTarget, signal, 'Unstaging files', async (root) => {
      const runtime = runtimeSelection(invalidationTarget);
      const paths = selectedPaths(root, selection);
      const args =
        selection.all || !(await hasHead(root, runtime, signal))
          ? ['reset', '--', ...paths]
          : ['restore', '--staged', '--', ...paths];
      await runSelectedGit(runtime, args, {
        cwd: root,
        signal,
      });
      return await getRepoStatus(root, signal, runtime);
    })
  );
}

export function discardPaths(
  workdir: string,
  input: Pick<DiscardPathsBody, 'paths' | 'mode'>,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitStatus> {
  return publishAfterSuccessfulMutation(
    invalidationTarget,
    'discard',
    runRepoMutation(workdir, invalidationTarget, signal, 'Discarding changes', async (root) => {
      const runtime = runtimeSelection(invalidationTarget);
      const pathspecs = validateRepoPaths(root, input.paths);
      if (input.mode === 'tracked') {
        // Restore only the worktree so staged index entries survive.
        await runSelectedGit(runtime, ['restore', '--worktree', '--', ...pathspecs], {
          cwd: root,
          signal,
        });
        return await getRepoStatus(root, signal, runtime);
      }

      const status = await getRepoStatus(root, signal, runtime);
      const untracked = new Set(status.untracked.map((change) => change.path));
      for (const path of input.paths) {
        if (!untracked.has(path)) {
          throw new GitWriteError(
            `Path is not an untracked file: ${path}`,
            422,
            ERROR_CODES.VALIDATION
          );
        }
      }
      await runSelectedGit(runtime, ['clean', '-f', '--', ...pathspecs], {
        cwd: root,
        signal,
      });
      const cleaned = await getRepoStatus(root, signal, runtime);
      // `git clean -f` refuses to delete a directory owned by another Git
      // repository and still exits 0, so a surviving entry is a silent no-op that
      // must not be reported to the caller as a successful deletion.
      const survivors = new Set(cleaned.untracked.map((change) => change.path));
      const skipped = input.paths.filter((path) => survivors.has(path));
      if (skipped.length > 0) {
        throw new GitWriteError(
          `Git refused to delete paths owned by another repository: ${skipped.join(', ')}`,
          409,
          ERROR_CODES.CONFLICT
        );
      }
      return cleaned;
    })
  );
}

export function commitChanges(
  workdir: string,
  input: Pick<CommitBody, 'title' | 'body' | 'amend'>,
  settings: GitSettings,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<CommitResponse> {
  return publishAfterSuccessfulMutation(
    invalidationTarget,
    'commit',
    runRepoMutation(
      workdir,
      invalidationTarget,
      signal,
      'Commit',
      async (root) => {
        const runtime = runtimeSelection(invalidationTarget);
        const amend = input.amend ?? false;
        if (amend && !(await hasHead(root, runtime, signal))) {
          throw new GitWriteError(
            'There is no commit to amend.',
            409,
            ERROR_CODES.AMEND_WITHOUT_HEAD
          );
        }

        const title = input.title.trim();
        const body = input.body?.trim() || undefined;
        await runSelectedGit(
          runtime,
          buildCommitArgs({
            title,
            body,
            amend,
            signOff: settings.signOff,
            signCommits: settings.signCommits,
          }),
          { cwd: root, signal, timeoutMs: COMMIT_TIMEOUT_MS }
        );

        const result = await runSelectedGit(runtime, ['log', '-1', '--format=%H%x00%s'], {
          cwd: root,
          signal,
        });
        const separator = result.stdout.indexOf('\0');
        return {
          hash: result.stdout.slice(0, separator).trim(),
          subject: result.stdout.slice(separator + 1).trim(),
        };
      },
      mapCommitFailure
    )
  );
}

export function stashSave(
  workdir: string,
  input: Pick<StashSaveBody, 'message' | 'includeUntracked'>,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return publishAfterSuccessfulMutation(
    invalidationTarget,
    'stashSave',
    runRepoMutation(workdir, invalidationTarget, signal, 'Saving stash', async (root) => {
      const runtime = runtimeSelection(invalidationTarget);
      const message = input.message?.trim();
      await runSelectedGit(
        runtime,
        [
          'stash',
          'push',
          ...(input.includeUntracked ? ['-u'] : []),
          ...(message ? ['-m', message] : []),
        ],
        { cwd: root, signal }
      );
      return await currentRepoState(workdir, root, runtime, signal);
    })
  );
}

export function stashPop(
  workdir: string,
  input: Pick<StashPopBody, 'index'>,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return restoreStash(workdir, 'pop', input.index ?? 0, invalidationTarget, 'stashPop', signal);
}

/** Restores a stash into the worktree while leaving the entry on the stack. */
export function stashApply(
  workdir: string,
  input: Pick<StashApplyBody, 'index'>,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return restoreStash(workdir, 'apply', input.index ?? 0, invalidationTarget, 'stashApply', signal);
}

export function stashDrop(
  workdir: string,
  input: Pick<StashDropBody, 'index'>,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<StashListResponse> {
  // Dropping only removes a stack entry, so the caller needs the new list
  // rather than the untouched worktree state every other stash write returns.
  return publishAfterSuccessfulMutation(
    invalidationTarget,
    'stashDrop',
    runRepoMutation(workdir, invalidationTarget, signal, 'Dropping stash', async (root) => {
      const runtime = runtimeSelection(invalidationTarget);
      await runSelectedGit(runtime, ['stash', 'drop', `stash@{${input.index ?? 0}}`], {
        cwd: root,
        signal,
      });
      return await readStashList(root, signal, runtime);
    })
  );
}

function restoreStash(
  workdir: string,
  command: 'pop' | 'apply',
  index: number,
  invalidationTarget: GitInvalidationTarget,
  invalidationOperation: 'stashPop' | 'stashApply',
  signal?: AbortSignal
): Promise<GitRepoState> {
  return publishAfterSuccessfulMutation(
    invalidationTarget,
    invalidationOperation,
    runRepoMutation(workdir, invalidationTarget, signal, 'Applying stash', async (root) => {
      const runtime = runtimeSelection(invalidationTarget);
      try {
        await runSelectedGit(runtime, ['stash', command, `stash@{${index}}`], {
          cwd: root,
          signal,
        });
      } catch (error) {
        // Only a merge-conflict failure means the stash actually landed; other
        // failures (a dirty index, a missing entry) must not be reported as an
        // applied-with-conflicts pop just because the repo already had conflicts.
        if (
          error instanceof GitCliError &&
          MERGE_CONFLICT_PATTERN.test(combinedCommandOutput(error))
        ) {
          const status = await getRepoStatus(root, signal, runtime);
          if (status.conflicted.length > 0) {
            throw new GitWriteError(
              'The stash was applied with conflicts. Resolve them in the working tree.',
              409,
              ERROR_CODES.STASH_CONFLICT,
              commandDetail(error)
            );
          }
        }
        throw error;
      }
      return await currentRepoState(workdir, root, runtime, signal);
    })
  );
}

export async function stashList(
  workdir: string,
  signal?: AbortSignal,
  selection?: GitRuntimeSelection
): Promise<StashListResponse> {
  try {
    const root = await requireRepoRoot(workdir, signal, selection);
    return await readStashList(root, signal, selection);
  } catch (error) {
    return mapWriteFailure(error, 'Listing stashes');
  }
}

async function readStashList(
  root: string,
  signal?: AbortSignal,
  selection?: GitRuntimeSelection
): Promise<StashListResponse> {
  const result = await runGit(['stash', 'list', '--format=%gd%x00%gs'], {
    cwd: root,
    signal,
    ...selection,
  });
  return { stashes: parseStashList(result.stdout) };
}

export async function listBranches(
  workdir: string,
  signal?: AbortSignal,
  selection?: GitRuntimeSelection
): Promise<GitBranchesResponse> {
  try {
    const root = await requireRepoRoot(workdir, signal, selection);
    return await readBranches(root, signal, selection);
  } catch (error) {
    return mapWriteFailure(error, 'Listing branches');
  }
}

async function readBranches(
  root: string,
  signal?: AbortSignal,
  selection?: GitRuntimeSelection
): Promise<GitBranchesResponse> {
  const [localResult, remoteResult] = await Promise.all([
    runGit(
      [
        'for-each-ref',
        '--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track,nobracket)%00',
        'refs/heads',
      ],
      { cwd: root, signal, ...selection }
    ),
    runGit(['for-each-ref', '--format=%(refname:short)%00', 'refs/remotes'], {
      cwd: root,
      signal,
      ...selection,
    }),
  ]);
  const branches = parseBranchList(localResult.stdout);
  const localNames = new Set(branches.map((branch) => branch.name));
  const remotes = parseRemoteBranchList(remoteResult.stdout).filter(
    (remote) => !localNames.has(remote.name)
  );
  return { branches, remotes };
}

export function switchBranch(
  workdir: string,
  name: string,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return publishAfterSuccessfulMutation(
    invalidationTarget,
    'switchBranch',
    runRepoMutation(workdir, invalidationTarget, signal, 'Switching branches', async (root) => {
      const runtime = runtimeSelection(invalidationTarget);
      try {
        await runSelectedGit(runtime, ['switch', '--', name], { cwd: root, signal });
      } catch (error) {
        mapBranchSwitchFailure(error);
      }
      return await currentRepoState(workdir, root, runtime, signal);
    })
  );
}

/**
 * Creates a local tracking branch from a remote-tracking ref (for example
 * `origin/feat/x`), or switches to the existing local branch of the same name.
 */
export function checkoutRemoteBranch(
  workdir: string,
  remoteRef: string,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return publishAfterSuccessfulMutation(
    invalidationTarget,
    'checkoutRemote',
    runRepoMutation(
      workdir,
      invalidationTarget,
      signal,
      'Checking out remote branch',
      async (root) => {
        const runtime = runtimeSelection(invalidationTarget);
        const slash = remoteRef.indexOf('/');
        if (slash <= 0 || slash === remoteRef.length - 1 || remoteRef.includes('\0')) {
          throw new GitWriteError('Remote branch ref is invalid.', 422, ERROR_CODES.VALIDATION);
        }
        const localName = remoteRef.slice(slash + 1);

        // `--quiet` turns a missing ref into exit 1 with no output; every other
        // failure (a malformed ref, an unreadable object store, an aborted command)
        // still raises and must not be reported as a missing branch.
        const verified = await runSelectedGit(
          runtime,
          ['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteRef}`],
          { cwd: root, signal, acceptedExitCodes: [1] }
        );
        if (verified.exitCode !== 0) {
          throw new GitWriteError(
            `Remote branch was not found: ${remoteRef}`,
            404,
            ERROR_CODES.NOT_FOUND
          );
        }

        try {
          if (await hasLocalBranch(root, localName, runtime, signal)) {
            await runSelectedGit(runtime, ['switch', '--', localName], { cwd: root, signal });
          } else {
            await runSelectedGit(runtime, ['switch', '--track', '--', remoteRef], {
              cwd: root,
              signal,
            });
          }
        } catch (error) {
          mapBranchSwitchFailure(error);
        }
        return await currentRepoState(workdir, root, runtime, signal);
      }
    )
  );
}

async function hasLocalBranch(
  root: string,
  name: string,
  selection: GitRuntimeSelection,
  signal?: AbortSignal
): Promise<boolean> {
  const result = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], {
    cwd: root,
    signal,
    ...selection,
    acceptedExitCodes: [1],
  });
  return result.exitCode === 0;
}

export function createBranch(
  workdir: string,
  name: string,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return publishAfterSuccessfulMutation(
    invalidationTarget,
    'createBranch',
    runRepoMutation(workdir, invalidationTarget, signal, 'Creating branch', async (root) => {
      const runtime = runtimeSelection(invalidationTarget);
      await runSelectedGit(runtime, ['check-ref-format', '--branch', name], {
        cwd: root,
        signal,
      });
      await runSelectedGit(runtime, ['switch', '-c', name], { cwd: root, signal });
      return await currentRepoState(workdir, root, runtime, signal);
    })
  );
}

export function deleteBranch(
  workdir: string,
  input: Pick<DeleteBranchBody, 'name' | 'force'>,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitBranchesResponse> {
  return publishAfterSuccessfulMutation(
    invalidationTarget,
    'deleteBranch',
    runRepoMutation(workdir, invalidationTarget, signal, 'Deleting branch', async (root) => {
      const runtime = runtimeSelection(invalidationTarget);
      const status = await getRepoStatus(root, signal, runtime);
      if (status.branch.name === input.name) {
        throw new GitWriteError(
          'Switch to another branch before deleting this one.',
          409,
          ERROR_CODES.CONFLICT
        );
      }
      try {
        await runSelectedGit(runtime, ['branch', input.force ? '-D' : '-d', '--', input.name], {
          cwd: root,
          signal,
        });
      } catch (error) {
        mapBranchDeleteFailure(error);
      }
      return await readBranches(root, signal, runtime);
    })
  );
}

export function renameBranch(
  workdir: string,
  input: Pick<RenameBranchBody, 'name' | 'newName'>,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitRepoState> {
  // Renaming the checked-out branch changes `status.branch.name`, so the caller
  // gets the whole repository state back rather than just the branch list.
  return publishAfterSuccessfulMutation(
    invalidationTarget,
    'renameBranch',
    runRepoMutation(workdir, invalidationTarget, signal, 'Renaming branch', async (root) => {
      const runtime = runtimeSelection(invalidationTarget);
      await runSelectedGit(runtime, ['check-ref-format', '--branch', input.newName], {
        cwd: root,
        signal,
      });
      await runSelectedGit(runtime, ['branch', '-m', '--', input.name, input.newName], {
        cwd: root,
        signal,
      });
      return await currentRepoState(workdir, root, runtime, signal);
    })
  );
}

export function fetchRemote(
  workdir: string,
  prune: boolean,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return runRemoteMutation(
    workdir,
    signal,
    'Fetching remote',
    invalidationTarget,
    'fetch',
    async (root, runtime) => {
      await runSelectedGit(runtime, ['fetch', ...(prune ? ['--prune'] : [])], {
        cwd: root,
        signal,
        timeoutMs: REMOTE_TIMEOUT_MS,
      });
    }
  );
}

export function pullFastForward(
  workdir: string,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return runRemoteMutation(
    workdir,
    signal,
    'Pulling changes',
    invalidationTarget,
    'pull',
    async (root, runtime) => {
      await runSelectedGit(runtime, ['pull', '--ff-only'], {
        cwd: root,
        signal,
        timeoutMs: REMOTE_TIMEOUT_MS,
      });
    }
  );
}

export function pushBranch(
  workdir: string,
  input: Pick<GitPushBody, 'force'>,
  invalidationTarget: GitInvalidationTarget,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return runRemoteMutation(
    workdir,
    signal,
    'Pushing changes',
    invalidationTarget,
    'push',
    async (root, runtime) => {
      const status = await getRepoStatus(root, signal, runtime);
      if (!status.branch.name) {
        throw new GitWriteError(
          'Create or switch to a branch before pushing.',
          409,
          ERROR_CODES.CONFLICT
        );
      }
      // A lease is a claim that the remote ref still points where this clone last
      // saw it. Without an upstream there is nothing to lease against, and Git
      // would fall back to an unconditional overwrite.
      if (input.force && !status.branch.upstream) {
        throw new GitWriteError(
          'Publish the branch before forcing a push.',
          422,
          ERROR_CODES.VALIDATION
        );
      }
      const args = status.branch.upstream
        ? ['push', ...(input.force === 'with-lease' ? ['--force-with-lease'] : [])]
        : [
            'push',
            '--set-upstream',
            await defaultPushRemote(root, runtime, signal),
            `refs/heads/${status.branch.name}`,
          ];
      await runSelectedGit(runtime, args, {
        cwd: root,
        signal,
        timeoutMs: REMOTE_TIMEOUT_MS,
      });
    }
  );
}

function runRemoteMutation(
  workdir: string,
  signal: AbortSignal | undefined,
  operation: string,
  invalidationTarget: GitInvalidationTarget,
  invalidationOperation: 'fetch' | 'pull' | 'push',
  command: (root: string, selection: GitRuntimeSelection) => Promise<void>
): Promise<GitRepoState> {
  return publishAfterSuccessfulMutation(
    invalidationTarget,
    invalidationOperation,
    runRepoMutation(
      workdir,
      invalidationTarget,
      signal,
      operation,
      async (root) => {
        const runtime = runtimeSelection(invalidationTarget);
        await command(root, runtime);
        return await currentRepoState(workdir, root, runtime, signal);
      },
      mapRemoteFailure
    )
  );
}

async function defaultPushRemote(
  root: string,
  selection: GitRuntimeSelection,
  signal?: AbortSignal
): Promise<string> {
  const result = await runGit(['remote'], { cwd: root, signal, ...selection });
  const remotes = result.stdout.split(/\r?\n/).filter(Boolean);
  if (remotes.includes('origin')) return 'origin';
  if (remotes.length === 1 && remotes[0]) return remotes[0];
  throw new GitWriteError(
    remotes.length === 0
      ? 'Add a Git remote before pushing.'
      : 'Set an upstream branch before pushing from a repository with multiple remotes.',
    409,
    ERROR_CODES.CONFLICT
  );
}

function mapBranchSwitchFailure(error: unknown): never {
  if (error instanceof GitCliError) {
    const output = combinedCommandOutput(error);
    const paths = parseCheckoutBlockedPaths(output);
    if (paths.length > 0 || /would be overwritten by (?:checkout|switch)/i.test(output)) {
      throw new GitWriteError(
        'Local changes would be overwritten by switching branches.',
        409,
        ERROR_CODES.CHECKOUT_BLOCKED,
        paths.join('\n')
      );
    }
  }
  return mapWriteFailure(error, 'Switching branches');
}

function mapBranchDeleteFailure(error: unknown): never {
  if (error instanceof GitCliError && /not fully merged/i.test(combinedCommandOutput(error))) {
    throw new GitWriteError(
      'The branch has commits that are not merged anywhere else.',
      409,
      ERROR_CODES.BRANCH_NOT_MERGED,
      commandDetail(error)
    );
  }
  return mapWriteFailure(error, 'Deleting branch');
}

function mapRemoteFailure(error: unknown, operation: string): never {
  if (error instanceof GitWriteError) throw error;
  if (error instanceof GitCliError) {
    const output = combinedCommandOutput(error);
    if (
      /authentication failed|could not read (?:username|password)|permission denied \(publickey\)|terminal prompts disabled/i.test(
        output
      )
    ) {
      throw new GitWriteError(
        'Git authentication is required. Check your credential helper or SSH agent.',
        422,
        ERROR_CODES.AUTH_REQUIRED
      );
    }
    if (/not possible to fast-forward|cannot fast-forward/i.test(output)) {
      throw new GitWriteError(
        'The branch cannot be fast-forwarded. Resolve the divergence in a terminal.',
        409,
        ERROR_CODES.NON_FAST_FORWARD
      );
    }
    if (/non-fast-forward|fetch first|updates were rejected|stale info/i.test(output)) {
      throw new GitWriteError(
        'The remote history has diverged. Fetch and resolve it before pushing again.',
        409,
        ERROR_CODES.HISTORY_DIVERGED
      );
    }
  }
  return mapWriteFailure(error, operation);
}
