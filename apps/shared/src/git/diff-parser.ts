export type GitDiffLineType = 'context' | 'addition' | 'deletion' | 'metadata';

export interface GitDiffLine {
  readonly type: GitDiffLineType;
  readonly content: string;
  readonly oldLine?: number;
  readonly newLine?: number;
}

export interface GitDiffHunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly GitDiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Parses unified diff hunks without interpreting file headers as content.
 *
 * A hunk's body is bounded by the counts in its header, not by the next line
 * that happens to lack a prefix: `git diff` output ends in a newline, so a
 * plain `split('\n')` leaves a trailing `''` that would otherwise read as one
 * more context line, numbered one past the hunk. While either count is still
 * owed, an empty line *is* context (a blank line whose leading space was
 * stripped on the way here); once both are spent, every line is ignored until
 * the next `@@` header, except the `\ No newline at end of file` marker that
 * git writes after a hunk's last line.
 */
export function parseGitDiff(diff: string): readonly GitDiffHunk[] {
  const hunks: GitDiffHunk[] = [];
  let current: {
    header: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: GitDiffLine[];
    oldLine: number;
    newLine: number;
    remainingOld: number;
    remainingNew: number;
  } | null = null;

  for (const rawLine of diff.split('\n')) {
    const header = HUNK_HEADER.exec(rawLine);
    if (header) {
      if (current) hunks.push(finalizeHunk(current));
      const oldStart = Number(header[1]);
      const newStart = Number(header[3]);
      const oldLines = Number(header[2] ?? 1);
      const newLines = Number(header[4] ?? 1);
      current = {
        header: rawLine,
        oldStart,
        oldLines,
        newStart,
        newLines,
        lines: [],
        oldLine: oldStart,
        newLine: newStart,
        remainingOld: oldLines,
        remainingNew: newLines,
      };
      continue;
    }
    if (!current) continue;

    if (rawLine.startsWith('\\')) {
      current.lines.push({ type: 'metadata', content: rawLine });
      continue;
    }
    if (current.remainingOld <= 0 && current.remainingNew <= 0) continue;

    if (rawLine.startsWith('+')) {
      current.remainingNew--;
      current.lines.push({
        type: 'addition',
        content: rawLine.slice(1),
        newLine: current.newLine++,
      });
    } else if (rawLine.startsWith('-')) {
      current.remainingOld--;
      current.lines.push({
        type: 'deletion',
        content: rawLine.slice(1),
        oldLine: current.oldLine++,
      });
    } else if (rawLine.startsWith(' ') || rawLine === '') {
      current.remainingOld--;
      current.remainingNew--;
      current.lines.push({
        type: 'context',
        content: rawLine.slice(1),
        oldLine: current.oldLine++,
        newLine: current.newLine++,
      });
    }
  }

  if (current) hunks.push(finalizeHunk(current));
  return hunks;
}

function finalizeHunk(hunk: {
  readonly header: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: GitDiffLine[];
}): GitDiffHunk {
  return {
    header: hunk.header,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines,
  };
}
