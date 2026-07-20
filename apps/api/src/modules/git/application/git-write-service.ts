import type { GitSettings } from '@mangostudio/shared/app-settings';
import { ERROR_CODES, type ErrorCode } from '@mangostudio/shared/errors';
import type {
  CommitBody,
  CommitResponse,
  GitRepoState,
  GitStatus,
  StagePathsBody,
  StashListResponse,
  StashPopBody,
  StashSaveBody,
  UnstagePathsBody,
} from '@mangostudio/shared/git';
import { buildCommitArgs } from '../domain/commit-command';
import { GitPathValidationError, validateRepoPaths } from '../domain/path-validation';
import { parseStashList } from '../domain/stash-parser';
import { GitCliError, runGit } from '../infrastructure/git-cli';
import { getRepoRoot, getRepoStatus } from './git-status-service';

type PathSelection = Pick<StagePathsBody | UnstagePathsBody, 'all' | 'paths'>;

const mutationQueues = new Map<string, Promise<void>>();
const COMMIT_TIMEOUT_MS = 60_000;

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

/** Serializes index mutations for one workdir while allowing independent repos to proceed. */
async function withMutationLock<T>(workdir: string, mutation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(workdir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = previous.then(() => current);
  mutationQueues.set(workdir, queue);

  await previous;
  try {
    return await mutation();
  } finally {
    release();
    if (mutationQueues.get(workdir) === queue) mutationQueues.delete(workdir);
  }
}

async function requireRepoRoot(workdir: string, signal?: AbortSignal): Promise<string> {
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

function mapWriteFailure(error: unknown, operation: string): never {
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

function mapCommitFailure(error: unknown): never {
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
  return mapWriteFailure(error, 'Commit');
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
  return withMutationLock(workdir, async () => {
    try {
      const root = await requireRepoRoot(workdir, signal);
      const paths = selectedPaths(root, selection);
      await runGit(selection.all ? ['add', '-A'] : ['add', '--', ...paths], {
        cwd: root,
        signal,
      });
      return await getRepoStatus(root, signal);
    } catch (error) {
      return mapWriteFailure(error, 'Staging files');
    }
  });
}

export function unstagePaths(
  workdir: string,
  selection: PathSelection,
  signal?: AbortSignal
): Promise<GitStatus> {
  return withMutationLock(workdir, async () => {
    try {
      const root = await requireRepoRoot(workdir, signal);
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
    } catch (error) {
      return mapWriteFailure(error, 'Unstaging files');
    }
  });
}

export function commitChanges(
  workdir: string,
  input: Pick<CommitBody, 'title' | 'body' | 'amend'>,
  settings: GitSettings,
  signal?: AbortSignal
): Promise<CommitResponse> {
  return withMutationLock(workdir, async () => {
    try {
      const root = await requireRepoRoot(workdir, signal);
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
    } catch (error) {
      return mapCommitFailure(error);
    }
  });
}

export function stashSave(
  workdir: string,
  input: Pick<StashSaveBody, 'message' | 'includeUntracked'>,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return withMutationLock(workdir, async () => {
    try {
      const root = await requireRepoRoot(workdir, signal);
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
    } catch (error) {
      return mapWriteFailure(error, 'Saving stash');
    }
  });
}

export function stashPop(
  workdir: string,
  input: Pick<StashPopBody, 'index'>,
  signal?: AbortSignal
): Promise<GitRepoState> {
  return withMutationLock(workdir, async () => {
    try {
      const root = await requireRepoRoot(workdir, signal);
      try {
        await runGit(['stash', 'pop', `stash@{${input.index ?? 0}}`], { cwd: root, signal });
      } catch (error) {
        if (error instanceof GitCliError) {
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
    } catch (error) {
      return mapWriteFailure(error, 'Applying stash');
    }
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
