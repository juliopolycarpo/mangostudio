import type { GitCommitFile, GitCommitSummary, GitFileStatus } from '@mangostudio/shared/git';

const RECORD_SEPARATOR = '\x1e';
const FIELD_SEPARATOR = '\x1f';

export const GIT_LOG_FORMAT = `%x1e%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%D`;

export function parseHistoryLog(output: string): GitCommitSummary[] {
  return output
    .split(RECORD_SEPARATOR)
    .filter(Boolean)
    .map((record) => {
      const [metadata = '', ...statLines] = record.replace(/^\r?\n/, '').split(/\r?\n/);
      const [hash = '', shortHash = '', subject = '', author = '', authoredAt = '', refs = ''] =
        metadata.split(FIELD_SEPARATOR);
      const stats = sumNumstat(statLines);
      return {
        hash,
        shortHash,
        subject,
        author,
        authoredAt,
        refs: refs
          .split(',')
          .map((ref) => ref.trim())
          .filter(Boolean),
        ...stats,
      };
    });
}

export function parseCommitFiles(nameStatus: string, numstat: string): GitCommitFile[] {
  const stats = parseNumstat(numstat);
  const fields = nameStatus.split('\0');
  const files: GitCommitFile[] = [];

  for (let index = 0; index < fields.length; index++) {
    const statusCode = fields[index];
    if (!statusCode) continue;
    const status = mapFileStatus(statusCode[0] ?? 'M');
    const oldPath =
      statusCode.startsWith('R') || statusCode.startsWith('C') ? fields[++index] : null;
    const path = fields[++index];
    if (!path) continue;
    const fileStats = stats.get(path) ?? { additions: 0, deletions: 0 };
    files.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      status,
      ...fileStats,
    });
  }
  return files;
}

function sumNumstat(lines: readonly string[]) {
  let changedFiles = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!match) continue;
    changedFiles++;
    additions += match[1] === '-' ? 0 : Number(match[1]);
    deletions += match[2] === '-' ? 0 : Number(match[2]);
  }
  return { changedFiles, additions, deletions };
}

function parseNumstat(output: string) {
  const fields = output.split('\0');
  const stats = new Map<string, Pick<GitCommitFile, 'additions' | 'deletions'>>();
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(field);
    if (!match) continue;
    let path = match[3];
    if (!path) {
      index++;
      path = fields[++index] ?? '';
    }
    if (!path) continue;
    stats.set(path, {
      additions: match[1] === '-' ? null : Number(match[1]),
      deletions: match[2] === '-' ? null : Number(match[2]),
    });
  }
  return stats;
}

function mapFileStatus(code: string): GitFileStatus {
  return (
    (
      {
        A: 'added',
        C: 'copied',
        D: 'deleted',
        M: 'modified',
        R: 'renamed',
        T: 'type-changed',
        U: 'conflicted',
      } as const
    )[code] ?? 'modified'
  );
}
