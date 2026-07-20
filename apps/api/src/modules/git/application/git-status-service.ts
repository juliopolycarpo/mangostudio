import type { GitRepoState, InitRepoResponse } from '@mangostudio/shared/git';
import { parseGitStatus } from '../domain/status-parser';
import { GitCliError, isGitAvailable, runGit } from '../infrastructure/git-cli';

const NOT_A_REPOSITORY_EXIT_CODE = 128;

export async function getRepoState(workdir: string, signal?: AbortSignal): Promise<GitRepoState> {
  if (!(await isGitAvailable())) return { state: 'git-unavailable' };

  let root: string;
  try {
    const result = await runGit(['rev-parse', '--show-toplevel'], { cwd: workdir, signal });
    root = result.stdout.trim();
  } catch (error) {
    if (error instanceof GitCliError && error.exitCode === NOT_A_REPOSITORY_EXIT_CODE) {
      return { state: 'not-a-repo', workdir };
    }
    throw error;
  }

  const result = await runGit(['status', '--porcelain=v2', '--branch', '-z'], {
    cwd: workdir,
    signal,
  });
  return { state: 'repo', workdir, root, status: parseGitStatus(result.stdout) };
}

export async function initRepo(workdir: string, signal?: AbortSignal): Promise<InitRepoResponse> {
  if (!(await isGitAvailable())) {
    throw new GitCliError(['init'], null, 'Git is not available.');
  }
  await runGit(['init'], { cwd: workdir, signal });
  const result = await runGit(['rev-parse', '--show-toplevel'], { cwd: workdir, signal });
  return { root: result.stdout.trim() };
}
