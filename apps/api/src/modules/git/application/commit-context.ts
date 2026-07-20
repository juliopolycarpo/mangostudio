import type { GitFileChange, GitStatus } from '@mangostudio/shared/git';

export const DIFF_TRUNCATED_MARKER = '[diff truncated]';
export const RECENT_COMMIT_SUBJECTS_LIMIT = 10;

export interface BuildCommitContextInput {
  readonly status: GitStatus;
  readonly stagedDiff: string;
  readonly unstagedDiff: string;
  readonly recentSubjects: readonly string[];
  readonly maxDiffBytes: number;
}

export interface CommitContextResult {
  readonly context: string;
  readonly truncated: boolean;
}

interface TruncatedDiff {
  readonly text: string;
  readonly truncated: boolean;
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function formatChange(change: GitFileChange): string {
  const path = change.oldPath ? `${change.oldPath} -> ${change.path}` : change.path;
  return `- ${change.status}: ${path}`;
}

function formatChangeBucket(label: string, changes: readonly GitFileChange[]): string {
  return `${label}:\n${changes.length > 0 ? changes.map(formatChange).join('\n') : '- (none)'}`;
}

function splitDiffByFile(diff: string): string[] {
  const normalized = diff.trim();
  if (!normalized) return [];

  const lines = normalized.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

function normalizeGitPath(value: string): string {
  const trimmed = value.trim();
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"')
      ? (() => {
          try {
            return JSON.parse(trimmed) as string;
          } catch {
            return trimmed.slice(1, -1);
          }
        })()
      : trimmed;
  return unquoted.startsWith('b/') || unquoted.startsWith('a/') ? unquoted.slice(2) : unquoted;
}

function binaryPath(chunk: string): string {
  for (const line of chunk.split('\n')) {
    if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
      const paths = line.slice('Binary files '.length, -' differ'.length);
      const separator = paths.lastIndexOf(' and ');
      if (separator >= 0) return normalizeGitPath(paths.slice(separator + ' and '.length));
    }
  }

  const header = chunk.split('\n', 1)[0] ?? '';
  const destinationMarker = ' b/';
  const destinationIndex = header.lastIndexOf(destinationMarker);
  return destinationIndex >= 0
    ? normalizeGitPath(header.slice(destinationIndex + 1))
    : '(unknown path)';
}

function omitBinaryPatch(chunk: string): string {
  if (!chunk.includes('\nGIT binary patch') && !chunk.includes('\nBinary files ')) return chunk;
  return `[binary file: ${binaryPath(chunk)}]`;
}

/** Clips only at line boundaries so unified-diff and hunk headers stay intact. */
function clipAtLineBoundary(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(value) <= maxBytes) return value;

  const kept: string[] = [];
  let usedBytes = 0;
  for (const line of value.split('\n')) {
    const lineBytes = byteLength(line) + (kept.length > 0 ? 1 : 0);
    if (usedBytes + lineBytes > maxBytes) break;
    kept.push(line);
    usedBytes += lineBytes;
  }
  return kept.join('\n');
}

function truncateDiff(diff: string, maxBytes: number): TruncatedDiff {
  const chunks = splitDiffByFile(diff).map(omitBinaryPatch);
  const normalized = chunks.join('\n');
  if (byteLength(normalized) <= maxBytes) return { text: normalized, truncated: false };

  const marker = `\n${DIFF_TRUNCATED_MARKER}`;
  const separatorBytes = Math.max(0, chunks.length - 1);
  let remainingBytes = Math.max(0, maxBytes - byteLength(marker) - separatorBytes);
  const clippedChunks: string[] = new Array(chunks.length).fill('');

  // Allocating smallest-first lets the budget a small file leaves unused flow to the larger
  // ones, instead of stranding it behind files that were already clipped.
  const bySizeAscending = chunks
    .map((chunk, index) => ({ index, size: byteLength(chunk) }))
    .sort((left, right) => left.size - right.size);

  for (const [position, entry] of bySizeAscending.entries()) {
    const fairShare = Math.floor(remainingBytes / (bySizeAscending.length - position));
    const clipped = clipAtLineBoundary(chunks[entry.index], fairShare);
    clippedChunks[entry.index] = clipped;
    remainingBytes -= byteLength(clipped);
  }

  return { text: `${clippedChunks.filter(Boolean).join('\n')}${marker}`, truncated: true };
}

function formatUntrackedNames(status: GitStatus): string | null {
  if (status.staged.length > 0 || status.untracked.length === 0) return null;
  return `Untracked files (content not included):\n${status.untracked
    .map((change) => `- ${change.path}`)
    .join('\n')}`;
}

export function buildCommitContextWithMetadata(
  input: BuildCommitContextInput
): CommitContextResult {
  const usesStagedDiff = input.status.staged.length > 0;
  const diff = truncateDiff(
    usesStagedDiff ? input.stagedDiff : input.unstagedDiff,
    input.maxDiffBytes
  );
  const untrackedNames = formatUntrackedNames(input.status);
  const recentSubjects = input.recentSubjects.slice(0, RECENT_COMMIT_SUBJECTS_LIMIT);

  return {
    context: [
      'Changed files:',
      formatChangeBucket('Staged', input.status.staged),
      formatChangeBucket('Unstaged', input.status.unstaged),
      formatChangeBucket('Untracked', input.status.untracked),
      formatChangeBucket('Conflicted', input.status.conflicted),
      `Selected diff (${usesStagedDiff ? 'staged' : 'unstaged'}):\n${diff.text || '(no textual diff)'}`,
      untrackedNames,
      `Recent commit subjects:\n${
        recentSubjects.length > 0
          ? recentSubjects.map((subject) => `- ${subject}`).join('\n')
          : '- (no commits yet)'
      }`,
    ]
      .filter((section): section is string => section !== null)
      .join('\n\n'),
    truncated: diff.truncated,
  };
}
