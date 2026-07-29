import { ERROR_CODES } from '@mangostudio/shared/errors';
import {
  type GitCommitDetailsResponse,
  type GitCommitFile,
  type GitDiffResponse,
  type GitHeadMessageResponse,
  type GitHistoryResponse,
  splitCommitMessage,
} from '@mangostudio/shared/git';
import { parseCommitterIdentity } from '../domain/commit-command';
import { GIT_LOG_FORMAT, parseCommitFiles, parseHistoryLog } from '../domain/history-parser';
import {
  GitPathValidationError,
  resolveContainedPath,
  validateRepoPaths,
} from '../domain/path-validation';
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

/**
 * Resolves the identity `git commit --signoff` would append, so the form can
 * hide that one trailer without touching anybody else's.
 */
async function readSignoffIdentity(
  root: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    const result = await runGit(['var', 'GIT_COMMITTER_IDENT'], { cwd: root, signal });
    return parseCommitterIdentity(result.stdout);
  } catch {
    // Without an identity git cannot sign off either, so every trailer stays.
    return undefined;
  }
}

/**
 * Reads the message of the commit an amend would replace, so the form can show
 * the author what they are about to rewrite instead of silently discarding it.
 */
export async function getHeadMessage(
  workdir: string,
  signOff: boolean,
  signal?: AbortSignal
): Promise<GitHeadMessageResponse> {
  try {
    const root = await requireRepoRoot(workdir, signal);
    const [result, signoffIdentity] = await Promise.all([
      runGit(['log', '-1', '--format=%H%x00%B'], { cwd: root, signal }),
      signOff ? readSignoffIdentity(root, signal) : undefined,
    ]);
    const separator = result.stdout.indexOf('\0');
    if (separator < 0) {
      throw new GitWriteError('There is no commit to amend.', 409, ERROR_CODES.AMEND_WITHOUT_HEAD);
    }
    return {
      hash: result.stdout.slice(0, separator).trim(),
      ...splitCommitMessage(result.stdout.slice(separator + 1), { signoffIdentity }),
    };
  } catch (error) {
    if (isEmptyHistory(error)) {
      throw new GitWriteError('There is no commit to amend.', 409, ERROR_CODES.AMEND_WITHOUT_HEAD);
    }
    return mapWriteFailure(error, 'Reading the HEAD commit message');
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
      // `-s` suppresses the diff, so the totals come from `sumCommitFiles`.
      runGit(['show', '-s', `--format=${GIT_LOG_FORMAT}`, hash], {
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
        // `--no-index` reads the worktree directly instead of walking it as Git
        // does, so it follows symlinks out of the repository. Re-resolve the
        // path and re-check containment before handing it over.
        const containedPath = await resolveContainedPath(root, input.path);
        diff = containedPath
          ? (
              await runGit(['diff', '--no-index', '--no-color', '--', '/dev/null', containedPath], {
                cwd: root,
                signal,
                acceptedExitCodes: [1],
              })
            ).stdout
          : '';
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
