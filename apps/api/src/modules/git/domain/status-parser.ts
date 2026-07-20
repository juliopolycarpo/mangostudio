import type {
  GitBranchInfo,
  GitFileChange,
  GitFileStatus,
  GitStatus,
} from '@mangostudio/shared/git';

const STATUS_BY_CODE: Readonly<Record<string, GitFileStatus>> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
};

interface MutableBranchInfo {
  name: string | null;
  detachedAt?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  oid?: string;
}

/** Parses the exact output of `git status --porcelain=v2 --branch -z`. */
export function parseGitStatus(output: string): GitStatus {
  const staged: GitFileChange[] = [];
  const unstaged: GitFileChange[] = [];
  const untracked: GitFileChange[] = [];
  const conflicted: GitFileChange[] = [];
  const branch: MutableBranchInfo = { name: null, ahead: 0, behind: 0 };
  const records = output.split('\0');

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;

    if (record.startsWith('# ')) {
      parseBranchHeader(record, branch);
      continue;
    }

    if (record.startsWith('1 ')) {
      const { fields, path } = splitFixedFields(record, 8);
      appendTrackedChanges(fields[1], path, undefined, staged, unstaged);
      continue;
    }

    if (record.startsWith('2 ')) {
      const { fields, path: pairedPath } = splitFixedFields(record, 9);
      const tabIndex = pairedPath.indexOf('\t');
      const path = tabIndex >= 0 ? pairedPath.slice(0, tabIndex) : pairedPath;
      const oldPath =
        tabIndex >= 0 ? pairedPath.slice(tabIndex + 1) : (records[index + 1] ?? undefined);
      if (tabIndex < 0 && oldPath !== undefined) index++;
      appendTrackedChanges(fields[1], path, oldPath, staged, unstaged);
      continue;
    }

    if (record.startsWith('u ')) {
      const { path } = splitFixedFields(record, 10);
      conflicted.push({ path, status: 'conflicted' });
      continue;
    }

    if (record.startsWith('? ')) {
      untracked.push({ path: record.slice(2), status: 'untracked' });
    }
  }

  const branchInfo = finalizeBranch(branch);
  return {
    branch: branchInfo,
    staged,
    unstaged,
    untracked,
    conflicted,
    clean:
      staged.length === 0 &&
      unstaged.length === 0 &&
      untracked.length === 0 &&
      conflicted.length === 0,
  };
}

function parseBranchHeader(record: string, branch: MutableBranchInfo): void {
  const separator = record.indexOf(' ', 2);
  if (separator < 0) return;

  const key = record.slice(2, separator);
  const value = record.slice(separator + 1);
  if (key === 'branch.oid') {
    branch.oid = value;
  } else if (key === 'branch.head') {
    branch.name = value === '(detached)' ? null : value;
  } else if (key === 'branch.upstream') {
    branch.upstream = value;
  } else if (key === 'branch.ab') {
    const match = /^\+(\d+) -(\d+)$/.exec(value);
    if (match) {
      branch.ahead = Number(match[1]);
      branch.behind = Number(match[2]);
    }
  }
}

function finalizeBranch(branch: MutableBranchInfo): GitBranchInfo {
  const { oid: _oid, ...branchInfo } = branch;
  if (branchInfo.name === null && branch.oid && branch.oid !== '(initial)') {
    branchInfo.detachedAt = branch.oid;
  }
  return branchInfo;
}

function appendTrackedChanges(
  xy: string | undefined,
  path: string,
  oldPath: string | undefined,
  staged: GitFileChange[],
  unstaged: GitFileChange[]
): void {
  if (!xy || path.length === 0) return;
  const stagedStatus = STATUS_BY_CODE[xy[0]];
  const unstagedStatus = STATUS_BY_CODE[xy[1]];
  if (stagedStatus) staged.push(createChange(path, stagedStatus, oldPath));
  if (unstagedStatus) unstaged.push(createChange(path, unstagedStatus, oldPath));
}

function createChange(
  path: string,
  status: GitFileStatus,
  oldPath: string | undefined
): GitFileChange {
  return oldPath === undefined ? { path, status } : { path, status, oldPath };
}

function splitFixedFields(record: string, fieldCount: number): { fields: string[]; path: string } {
  const fields: string[] = [];
  let cursor = 0;
  for (let index = 0; index < fieldCount; index++) {
    const separator = record.indexOf(' ', cursor);
    if (separator < 0) return { fields, path: '' };
    fields.push(record.slice(cursor, separator));
    cursor = separator + 1;
  }
  return { fields, path: record.slice(cursor) };
}
