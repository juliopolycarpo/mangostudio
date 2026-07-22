import type { GitSettings } from '@mangostudio/shared/app-settings';
import { ERROR_CODES, type ErrorCode } from '@mangostudio/shared/errors';
import type {
  CommitBody,
  CommitResponse,
  DiscardPathsBody,
  GitBranchesResponse,
  GitRepoState,
  GitStatus,
  StagePathsBody,
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
import { GitCliError, isGitAvailable, runGit } from '../infrastructure/git-cli';
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
async function withMutationLock<T>(root: string, mutation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = previous.then(() => current);
  mutationQueues.set(root, queue);

  await previous;
  try {
    return await mutation();
  } finally {
    release();
    if (mutationQueues.get(root) === queue) mutationQueues.delete(root);
  }
}

export async function requireRepoRoot(workdir: string, signal?: AbortSignal): Promise<string> {
  if (!(await isGitAvailable())) {
    throw new GitWriteError('Git is not available on this system.', 409, ERROR_CODES.CONFLICT);
  }
  const root = await getRepoRoot(workdir, signal);
  if (root) return root;
  throw new GitWriteError('Working directory is not a Git repository.', 409, ERROR_CODES.CONFLICT);
}

async function currentRepoState(
  workdir: string,
  root: string,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return { state: 'repo', workdir, root, status: await getRepoStatus(root, signal) };
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

async function hasHead(root: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: root, signal });
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
  signal: AbortSignal | undefined,
  operation: string,
  mutation: (root: string) => Promise<T>,
  mapFailure: (error: unknown, operation: string) => never = mapWriteFailure
): Promise<T> {
  try {
    const root = await requireRepoRoot(workdir, signal);
    return await withMutationLock(root, () => mutation(root));
  } catch (error) {
    return mapFailure(error, operation);
  }
}

function selectedPaths(root: string, selection: PathSelection): string[] {
  if (selection.all) return [];
  return validateRepoPaths(root, selection.paths ?? []);
}

export function stagePaths(
  workdir: string,
  selection: PathSelection,
  signal?: AbortSignal
): Promise<GitStatus> {
  return runRepoMutation(workdir, signal, 'Staging files', async (root) => {
    const paths = selectedPaths(root, selection);
    await runGit(selection.all ? ['add', '-A'] : ['add', '--', ...paths], {
      cwd: root,
      signal,
    });
    return await getRepoStatus(root, signal);
  });
}

export function unstagePaths(
  workdir: string,
  selection: PathSelection,
  signal?: AbortSignal
): Promise<GitStatus> {
  return runRepoMutation(workdir, signal, 'Unstaging files', async (root) => {
    const paths = selectedPaths(root, selection);
    const args =
      selection.all || !(await hasHead(root, signal))
        ? ['reset', '--', ...paths]
        : ['restore', '--staged', '--', ...paths];
    await runGit(args, {
      cwd: root,
      signal,
    });
    return await getRepoStatus(root, signal);
  });
}

export function discardPaths(
  workdir: string,
  input: Pick<DiscardPathsBody, 'paths' | 'mode'>,
  signal?: AbortSignal
): Promise<GitStatus> {
  return runRepoMutation(workdir, signal, 'Discarding changes', async (root) => {
    const pathspecs = validateRepoPaths(root, input.paths);
    if (input.mode === 'tracked') {
      // Restore only the worktree so staged index entries survive.
      await runGit(['restore', '--worktree', '--', ...pathspecs], { cwd: root, signal });
      return await getRepoStatus(root, signal);
    }

    const status = await getRepoStatus(root, signal);
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
    await runGit(['clean', '-f', '--', ...pathspecs], { cwd: root, signal });
    return await getRepoStatus(root, signal);
  });
}

export function commitChanges(
  workdir: string,
  input: Pick<CommitBody, 'title' | 'body' | 'amend'>,
  settings: GitSettings,
  signal?: AbortSignal
): Promise<CommitResponse> {
  return runRepoMutation(
    workdir,
    signal,
    'Commit',
    async (root) => {
      const amend = input.amend ?? false;
      if (amend && !(await hasHead(root, signal))) {
        throw new GitWriteError(
          'There is no commit to amend.',
          409,
          ERROR_CODES.AMEND_WITHOUT_HEAD
        );
      }

      const title = input.title.trim();
      const body = input.body?.trim() || undefined;
      await runGit(
        buildCommitArgs({
          title,
          body,
          amend,
          signOff: settings.signOff,
          signCommits: settings.signCommits,
        }),
        { cwd: root, signal, timeoutMs: COMMIT_TIMEOUT_MS }
      );

      const result = await runGit(['log', '-1', '--format=%H%x00%s'], { cwd: root, signal });
      const separator = result.stdout.indexOf('\0');
      return {
        hash: result.stdout.slice(0, separator).trim(),
        subject: result.stdout.slice(separator + 1).trim(),
      };
    },
    mapCommitFailure
  );
}

export function stashSave(
  workdir: string,
  input: Pick<StashSaveBody, 'message' | 'includeUntracked'>,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return runRepoMutation(workdir, signal, 'Saving stash', async (root) => {
    const message = input.message?.trim();
    await runGit(
      [
        'stash',
        'push',
        ...(input.includeUntracked ? ['-u'] : []),
        ...(message ? ['-m', message] : []),
      ],
      { cwd: root, signal }
    );
    return await currentRepoState(workdir, root, signal);
  });
}

export function stashPop(
  workdir: string,
  input: Pick<StashPopBody, 'index'>,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return runRepoMutation(workdir, signal, 'Applying stash', async (root) => {
    try {
      await runGit(['stash', 'pop', `stash@{${input.index ?? 0}}`], { cwd: root, signal });
    } catch (error) {
      // Only a merge-conflict failure means the stash actually landed; other
      // failures (a dirty index, a missing entry) must not be reported as an
      // applied-with-conflicts pop just because the repo already had conflicts.
      if (
        error instanceof GitCliError &&
        MERGE_CONFLICT_PATTERN.test(combinedCommandOutput(error))
      ) {
        const status = await getRepoStatus(root, signal);
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
    return await currentRepoState(workdir, root, signal);
  });
}

export async function stashList(workdir: string, signal?: AbortSignal): Promise<StashListResponse> {
  try {
    const root = await requireRepoRoot(workdir, signal);
    const result = await runGit(['stash', 'list', '--format=%gd%x00%gs'], {
      cwd: root,
      signal,
    });
    return { stashes: parseStashList(result.stdout) };
  } catch (error) {
    return mapWriteFailure(error, 'Listing stashes');
  }
}

export async function listBranches(
  workdir: string,
  signal?: AbortSignal
): Promise<GitBranchesResponse> {
  try {
    const root = await requireRepoRoot(workdir, signal);
    const [localResult, remoteResult] = await Promise.all([
      runGit(
        [
          'for-each-ref',
          '--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track,nobracket)%00',
          'refs/heads',
        ],
        { cwd: root, signal }
      ),
      runGit(['for-each-ref', '--format=%(refname:short)%00', 'refs/remotes'], {
        cwd: root,
        signal,
      }),
    ]);
    const branches = parseBranchList(localResult.stdout);
    const localNames = new Set(branches.map((branch) => branch.name));
    const remotes = parseRemoteBranchList(remoteResult.stdout).filter(
      (remote) => !localNames.has(remote.name)
    );
    return { branches, remotes };
  } catch (error) {
    return mapWriteFailure(error, 'Listing branches');
  }
}

export function switchBranch(
  workdir: string,
  name: string,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return runRepoMutation(workdir, signal, 'Switching branches', async (root) => {
    try {
      await runGit(['switch', '--', name], { cwd: root, signal });
    } catch (error) {
      mapBranchSwitchFailure(error);
    }
    return await currentRepoState(workdir, root, signal);
  });
}

/**
 * Creates a local tracking branch from a remote-tracking ref (for example
 * `origin/feat/x`), or switches to the existing local branch of the same name.
 */
export function checkoutRemoteBranch(
  workdir: string,
  remoteRef: string,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return runRepoMutation(workdir, signal, 'Checking out remote branch', async (root) => {
    const slash = remoteRef.indexOf('/');
    if (slash <= 0 || slash === remoteRef.length - 1 || remoteRef.includes('\0')) {
      throw new GitWriteError('Remote branch ref is invalid.', 422, ERROR_CODES.VALIDATION);
    }
    const localName = remoteRef.slice(slash + 1);

    try {
      await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteRef}`], {
        cwd: root,
        signal,
      });
    } catch (error) {
      if (error instanceof GitCliError) {
        throw new GitWriteError(
          `Remote branch was not found: ${remoteRef}`,
          404,
          ERROR_CODES.NOT_FOUND,
          commandDetail(error)
        );
      }
      throw error;
    }

    try {
      if (await hasLocalBranch(root, localName, signal)) {
        await runGit(['switch', '--', localName], { cwd: root, signal });
      } else {
        await runGit(['switch', '--track', '--', remoteRef], { cwd: root, signal });
      }
    } catch (error) {
      mapBranchSwitchFailure(error);
    }
    return await currentRepoState(workdir, root, signal);
  });
}

async function hasLocalBranch(root: string, name: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], {
      cwd: root,
      signal,
    });
    return true;
  } catch (error) {
    if (error instanceof GitCliError && error.exitCode === 1) return false;
    throw error;
  }
}

export function createBranch(
  workdir: string,
  name: string,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return runRepoMutation(workdir, signal, 'Creating branch', async (root) => {
    await runGit(['check-ref-format', '--branch', name], { cwd: root, signal });
    await runGit(['switch', '-c', name], { cwd: root, signal });
    return await currentRepoState(workdir, root, signal);
  });
}

export function fetchRemote(
  workdir: string,
  prune: boolean,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return runRemoteMutation(workdir, signal, 'Fetching remote', async (root) => {
    await runGit(['fetch', ...(prune ? ['--prune'] : [])], {
      cwd: root,
      signal,
      timeoutMs: REMOTE_TIMEOUT_MS,
    });
  });
}

export function pullFastForward(workdir: string, signal?: AbortSignal): Promise<GitRepoState> {
  return runRemoteMutation(workdir, signal, 'Pulling changes', async (root) => {
    await runGit(['pull', '--ff-only'], { cwd: root, signal, timeoutMs: REMOTE_TIMEOUT_MS });
  });
}

export function pushBranch(workdir: string, signal?: AbortSignal): Promise<GitRepoState> {
  return runRemoteMutation(workdir, signal, 'Pushing changes', async (root) => {
    const status = await getRepoStatus(root, signal);
    if (!status.branch.name) {
      throw new GitWriteError(
        'Create or switch to a branch before pushing.',
        409,
        ERROR_CODES.CONFLICT
      );
    }
    const args = status.branch.upstream
      ? ['push']
      : [
          'push',
          '--set-upstream',
          await defaultPushRemote(root, signal),
          `refs/heads/${status.branch.name}`,
        ];
    await runGit(args, { cwd: root, signal, timeoutMs: REMOTE_TIMEOUT_MS });
  });
}

function runRemoteMutation(
  workdir: string,
  signal: AbortSignal | undefined,
  operation: string,
  command: (root: string) => Promise<void>
): Promise<GitRepoState> {
  return runRepoMutation(
    workdir,
    signal,
    operation,
    async (root) => {
      await command(root);
      return await currentRepoState(workdir, root, signal);
    },
    mapRemoteFailure
  );
}

async function defaultPushRemote(root: string, signal?: AbortSignal): Promise<string> {
  const result = await runGit(['remote'], { cwd: root, signal });
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
