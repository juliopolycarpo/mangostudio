import type { GitRepoState } from '@mangostudio/shared/git';
import { parseGitStatus } from '../domain/status-parser';
import {
  GitCliError,
  type GitRuntimeSelection,
  isGitAvailable,
  runGit,
} from '../infrastructure/git-cli';

const NOT_A_REPOSITORY_EXIT_CODE = 128;
/**
 * Git exits 128 for every fatal error, so the message is what separates "this
 * directory has no repository" from failures that must stay visible — dubious
 * ownership, an unreadable object store, a missing working directory.
 */
const NOT_A_REPOSITORY_PATTERN = /not a git repository/i;

function isMissingRepository(error: unknown): boolean {
  return (
    error instanceof GitCliError &&
    error.exitCode === NOT_A_REPOSITORY_EXIT_CODE &&
    NOT_A_REPOSITORY_PATTERN.test(error.stderr)
  );
}

export async function getRepoRoot(
  workdir: string,
  signal?: AbortSignal,
  selection?: GitRuntimeSelection
): Promise<string | null> {
  try {
    const result = await runGit(['rev-parse', '--show-toplevel'], {
      cwd: workdir,
      signal,
      ...selection,
    });
    return result.stdout.trim();
  } catch (error) {
    if (isMissingRepository(error)) return null;
    throw error;
  }
}

export async function getRepoStatus(
  root: string,
  signal?: AbortSignal,
  selection?: GitRuntimeSelection
) {
  const result = await runGit(['status', '--porcelain=v2', '--branch', '-z'], {
    cwd: root,
    signal,
    ...selection,
  });
  return parseGitStatus(result.stdout);
}

export async function getRepoState(
  workdir: string,
  signal?: AbortSignal,
  selection?: GitRuntimeSelection
): Promise<GitRepoState> {
  if (!(await isGitAvailable(selection))) return { state: 'git-unavailable' };

  const root = await getRepoRoot(workdir, signal, selection);
  if (!root) return { state: 'not-a-repo', workdir };

  return {
    state: 'repo',
    workdir,
    root,
    status: await getRepoStatus(root, signal, selection),
  };
}
