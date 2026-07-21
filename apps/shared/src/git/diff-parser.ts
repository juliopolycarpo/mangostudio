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

/** Parses unified diff hunks without interpreting file headers as content. */
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
  } | null = null;

  for (const rawLine of diff.split('\n')) {
    const header = HUNK_HEADER.exec(rawLine);
    if (header) {
      if (current) hunks.push(finalizeHunk(current));
      const oldStart = Number(header[1]);
      const newStart = Number(header[3]);
      current = {
        header: rawLine,
        oldStart,
        oldLines: Number(header[2] ?? 1),
        newStart,
        newLines: Number(header[4] ?? 1),
        lines: [],
        oldLine: oldStart,
        newLine: newStart,
      };
      continue;
    }
    if (!current) continue;

    if (rawLine.startsWith('\\ No newline at end of file')) {
      current.lines.push({ type: 'metadata', content: rawLine });
    } else if (rawLine.startsWith('+')) {
      current.lines.push({
        type: 'addition',
        content: rawLine.slice(1),
        newLine: current.newLine++,
      });
    } else if (rawLine.startsWith('-')) {
      current.lines.push({
        type: 'deletion',
        content: rawLine.slice(1),
        oldLine: current.oldLine++,
      });
    } else {
      const content = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine;
      current.lines.push({
        type: 'context',
        content,
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
