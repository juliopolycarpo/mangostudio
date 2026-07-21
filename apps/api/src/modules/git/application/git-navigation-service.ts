import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  GitCommitDetailsResponse,
  GitCommitFile,
  GitDiffResponse,
  GitHistoryResponse,
} from '@mangostudio/shared/git';
import { GIT_LOG_FORMAT, parseCommitFiles, parseHistoryLog } from '../domain/history-parser';
import { GitPathValidationError, validateRepoPaths } from '../domain/path-validation';
import { GitCliError, runGit } from '../infrastructure/git-cli';
import { GitWriteError, mapWriteFailure, requireRepoRoot } from './git-write-service';

const HISTORY_PAGE_SIZE = 20;
const BINARY_DIFF_PATTERN = /^Binary files |^GIT binary patch$/m;

export async function listHistory(
  workdir: string,
  cursor: string | undefined,
  signal?: AbortSignal
): Promise<GitHistoryResponse> {
  try {
    const root = await requireRepoRoot(workdir, signal);
    const offset = Number(cursor ?? 0);
    const result = await runGit(
      [
        'log',
        `--format=${GIT_LOG_FORMAT}`,
        '--numstat',
        `--max-count=${HISTORY_PAGE_SIZE + 1}`,
        `--skip=${offset}`,
      ],
      { cwd: root, signal }
    );
    const commits = parseHistoryLog(result.stdout);
    const hasMore = commits.length > HISTORY_PAGE_SIZE;
    return {
      commits: commits.slice(0, HISTORY_PAGE_SIZE),
      ...(hasMore ? { nextCursor: String(offset + HISTORY_PAGE_SIZE) } : {}),
    };
  } catch (error) {
    if (isEmptyHistory(error)) return { commits: [] };
    return mapWriteFailure(error, 'Reading history');
  }
}

export async function getCommitDetails(
  workdir: string,
  hash: string,
  signal?: AbortSignal
): Promise<GitCommitDetailsResponse> {
  try {
    const root = await requireRepoRoot(workdir, signal);
    const [summaryResult, nameStatusResult, numstatResult] = await Promise.all([
      runGit(['show', '-s', `--format=${GIT_LOG_FORMAT}`, '--numstat', hash], {
        cwd: root,
        signal,
      }),
      runGit(
        ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '-M', '-C', hash],
        { cwd: root, signal }
      ),
      runGit(['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', '-z', '-M', '-C', hash], {
        cwd: root,
        signal,
      }),
    ]);
    const commit = parseHistoryLog(summaryResult.stdout)[0];
    if (!commit) throw new GitWriteError('Commit not found.', 404, ERROR_CODES.NOT_FOUND);
    const files = parseCommitFiles(nameStatusResult.stdout, numstatResult.stdout);
    return {
      commit: {
        ...commit,
        ...sumCommitFiles(files),
      },
      files,
    };
  } catch (error) {
    if (
      error instanceof GitCliError &&
      /bad object|unknown revision|ambiguous argument/i.test(error.stderr)
    ) {
      throw new GitWriteError('Commit not found.', 404, ERROR_CODES.NOT_FOUND);
    }
    return mapWriteFailure(error, 'Reading commit');
  }
}

export async function getFileDiff(
  workdir: string,
  input: { path: string; staged?: boolean; commit?: string },
  signal?: AbortSignal
): Promise<GitDiffResponse> {
  try {
    const root = await requireRepoRoot(workdir, signal);
    const [pathspec] = validateRepoPaths(root, [input.path]);
    if (!pathspec) throw new GitPathValidationError(input.path);

    let diff: string;
    if (input.commit) {
      diff = (
        await runGit(
          [
            'show',
            '--format=',
            '--no-ext-diff',
            '--no-color',
            '--find-renames',
            input.commit,
            '--',
            pathspec,
          ],
          { cwd: root, signal }
        )
      ).stdout;
    } else {
      diff = (
        await runGit(
          [
            'diff',
            ...(input.staged ? ['--cached'] : []),
            '--no-ext-diff',
            '--no-color',
            '--',
            pathspec,
          ],
          { cwd: root, signal }
        )
      ).stdout;
      if (!input.staged && !diff && !(await isTracked(root, pathspec, signal))) {
        diff = (
          await runGit(['diff', '--no-index', '--no-color', '--', '/dev/null', input.path], {
            cwd: root,
            signal,
            acceptedExitCodes: [1],
          })
        ).stdout;
      }
    }
    return { path: input.path, diff, binary: BINARY_DIFF_PATTERN.test(diff) };
  } catch (error) {
    if (error instanceof GitPathValidationError) {
      throw new GitWriteError(
        'Repository paths must stay inside the repository root.',
        422,
        ERROR_CODES.VALIDATION
      );
    }
    return mapWriteFailure(error, 'Reading diff');
  }
}

async function isTracked(root: string, pathspec: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await runGit(['ls-files', '--error-unmatch', '--', pathspec], { cwd: root, signal });
    return true;
  } catch (error) {
    if (error instanceof GitCliError && error.exitCode === 1) return false;
    throw error;
  }
}

function isEmptyHistory(error: unknown): boolean {
  return (
    error instanceof GitCliError &&
    error.exitCode === 128 &&
    /does not have any commits yet|bad default revision|ambiguous argument 'HEAD'/i.test(
      error.stderr
    )
  );
}

function sumCommitFiles(files: readonly GitCommitFile[]) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { changedFiles: files.length, additions, deletions };
}
