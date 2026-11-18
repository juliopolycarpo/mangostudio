/**
 * Pure, non-throwing diff-preview computation for file-mutation tool calls.
 *
 * Previews are derived entirely from data already persisted on the tool call
 * (arguments plus the JSON result), so they must tolerate partially streamed
 * arguments and malformed results by degrading to `null` instead of throwing.
 */

/** Tool names that mutate files and can render as a diff preview. */
const FILE_CHANGE_TOOLS = new Set([
  'create_file',
  'write_file',
  'edit_file',
  'replace_range',
  'apply_patch',
  'delete_file',
  'move_file',
]);

/**
 * True when a tool name mutates files, so its call can render a diff preview.
 * Cheap membership test callers use before paying for the diff computation.
 *
 * // Usage: if (isFileChangeTool(name)) { ... }
 */
export function isFileChangeTool(toolName: string): boolean {
  return FILE_CHANGE_TOOLS.has(toolName);
}

/** Hard cap on rendered diff lines; the raw result stays available beyond it. */
export const DIFF_PREVIEW_MAX_LINES = 400;

/**
 * The LCS table is quadratic; beyond this cell budget the diff degrades to
 * delete-all/add-all instead of blocking the render pass.
 */
const LINE_DIFF_CELL_BUDGET = 250_000;

/** Unchanged lines kept on each side of a change, as in a unified diff. */
const DIFF_CONTEXT_LINES = 3;

/**
 * Intra-line emphasis is skipped for a line pair when either line is longer
 * than this many UTF-16 code units: minified output or a one-line JSON blob
 * would otherwise spend the render pass on a highlight nobody can read.
 */
export const INTRA_LINE_MAX_LINE_LENGTH = 1_000;

/**
 * At most this many del/add pairs per diff are examined for emphasis, so the
 * extra pass stays linear in the (already capped) diff size.
 */
export const INTRA_LINE_MAX_PAIRS = 200;

type DiffPreviewLineKind = 'add' | 'del' | 'context' | 'marker';

/** A half-open `[start, end)` range of UTF-16 code units within a line's text. */
interface DiffLineEmphasis {
  start: number;
  end: number;
}

export interface DiffPreviewLine {
  kind: DiffPreviewLineKind;
  text: string;
  /**
   * The span of an `add`/`del` line that differs from its paired line, set only
   * when a deletion run and an addition run of equal length were paired and
   * the two lines share a prefix or suffix. Absent means no emphasis.
   */
  emphasis?: DiffLineEmphasis;
}

type FileChangeOp = 'create' | 'overwrite' | 'update' | 'delete' | 'move';

export interface FileChangeFilePreview {
  op: FileChangeOp;
  path: string;
  /** Destination path for moves (move_file, apply_patch "Move to"). */
  movedTo?: string;
  lines: DiffPreviewLine[];
  added: number;
  removed: number;
}

export interface FileChangePreview {
  files: FileChangeFilePreview[];
  /** Number of applied occurrences when edit_file ran with replaceAll. */
  repeatCount?: number;
}

/**
 * Builds a diff preview for a file-mutation tool call, or `null` when the tool
 * is not previewable or its arguments are not (yet) usable.
 *
 * // Usage: const preview = buildFileChangePreview('edit_file', args, result);
 */
export function buildFileChangePreview(
  toolName: string,
  args: Record<string, unknown>,
  result?: string | null
): FileChangePreview | null {
  switch (toolName) {
    case 'create_file':
      return contentPreview(args, 'create');
    case 'write_file':
      return contentPreview(args, writeFileOp(result), result);
    case 'edit_file':
      return editFilePreview(args, result);
    case 'replace_range':
      return replaceRangePreview(args, result);
    case 'apply_patch':
      return applyPatchPreview(args);
    case 'delete_file':
      return typeof args.path === 'string' && args.path.length > 0
        ? { files: [{ op: 'delete', path: args.path, lines: [], added: 0, removed: 0 }] }
        : null;
    case 'move_file':
      return typeof args.from === 'string' &&
        args.from.length > 0 &&
        typeof args.to === 'string' &&
        args.to.length > 0
        ? {
            files: [
              { op: 'move', path: args.from, movedTo: args.to, lines: [], added: 0, removed: 0 },
            ],
          }
        : null;
    default:
      return null;
  }
}

/** Caps rendered lines, reporting how many were hidden by the budget. */
export function truncateDiffLines(
  lines: DiffPreviewLine[],
  maxLines: number = DIFF_PREVIEW_MAX_LINES
): { lines: DiffPreviewLine[]; hiddenCount: number } {
  if (lines.length <= maxLines) return { lines, hiddenCount: 0 };
  return { lines: lines.slice(0, maxLines), hiddenCount: lines.length - maxLines };
}

function parseResultObject(result: string | null | undefined): Record<string, unknown> | null {
  if (typeof result !== 'string' || result.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(result);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** write_file only reveals whether it overwrote via the result's created flag. */
function writeFileOp(result: string | null | undefined): FileChangeOp {
  const parsed = parseResultObject(result);
  return parsed?.created === false ? 'overwrite' : 'create';
}

function contentPreview(
  args: Record<string, unknown>,
  op: FileChangeOp,
  result?: string | null
): FileChangePreview | null {
  if (typeof args.path !== 'string' || args.path.length === 0) return null;
  if (typeof args.content !== 'string') return null;

  if (op === 'overwrite') {
    const parsed = parseResultObject(result);
    const before = parsed?.before;
    if (typeof before === 'string') {
      const lines = diffTextLines(before, args.content);
      return {
        files: [
          {
            op,
            path: args.path,
            lines,
            added: countKind(lines, 'add'),
            removed: countKind(lines, 'del'),
          },
        ],
      };
    }
  }

  const lines = splitLines(args.content).map<DiffPreviewLine>((text) => ({ kind: 'add', text }));
  return { files: [{ op, path: args.path, lines, added: lines.length, removed: 0 }] };
}

function editFilePreview(
  args: Record<string, unknown>,
  result: string | null | undefined
): FileChangePreview | null {
  if (typeof args.path !== 'string' || args.path.length === 0) return null;
  if (typeof args.oldString !== 'string' || typeof args.newString !== 'string') return null;

  const lines = diffTextLines(args.oldString, args.newString);
  const preview: FileChangePreview = {
    files: [
      {
        op: 'update',
        path: args.path,
        lines,
        added: countKind(lines, 'add'),
        removed: countKind(lines, 'del'),
      },
    ],
  };

  const replacements = parseResultObject(result)?.replacements;
  if (typeof replacements === 'number' && replacements > 1) {
    preview.repeatCount = replacements;
  }
  return preview;
}

function replaceRangePreview(
  args: Record<string, unknown>,
  result?: string | null
): FileChangePreview | null {
  if (typeof args.path !== 'string' || args.path.length === 0) return null;
  if (typeof args.content !== 'string') return null;
  // Mirrors the tool's own contract: 1-indexed inclusive integer line numbers.
  const { startLine, endLine } = args;
  if (typeof startLine !== 'number' || typeof endLine !== 'number') return null;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  if (startLine < 1 || endLine < startLine) return null;

  const removedCount = endLine - startLine + 1;
  const parsed = parseResultObject(result);
  const before = parsed?.before;
  if (typeof before === 'string') {
    const beforeLines = splitLines(before);
    const oldSlice = beforeLines.slice(startLine - 1, endLine).join('\n');
    const lines = diffTextLines(oldSlice, args.content);
    return {
      files: [
        {
          op: 'update',
          path: args.path,
          lines,
          added: countKind(lines, 'add'),
          removed: countKind(lines, 'del'),
        },
      ],
    };
  }

  // The replaced lines' previous content is not persisted with the call, so the
  // range is summarized as a unified-diff style marker followed by additions.
  const lines: DiffPreviewLine[] = [
    { kind: 'marker', text: `@@ -${startLine},${removedCount} @@` },
    ...splitLines(args.content).map<DiffPreviewLine>((text) => ({ kind: 'add', text })),
  ];
  return {
    files: [
      { op: 'update', path: args.path, lines, added: lines.length - 1, removed: removedCount },
    ],
  };
}

const PATCH_ADD_FILE = '*** Add File:';
const PATCH_UPDATE_FILE = '*** Update File:';
const PATCH_DELETE_FILE = '*** Delete File:';
const PATCH_MOVE_TO = '*** Move to:';

/**
 * Lenient scan of the V4A patch text purely for display. The backend parser
 * remains authoritative for application; rendering must tolerate a patch that
 * is still streaming in or that the backend later rejects.
 */
function applyPatchPreview(args: Record<string, unknown>): FileChangePreview | null {
  if (typeof args.patch !== 'string' || args.patch.length === 0) return null;

  const files: FileChangeFilePreview[] = [];
  let current: FileChangeFilePreview | null = null;

  for (const rawLine of args.patch.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    const header = parsePatchFileHeader(line);
    if (header) {
      current = { ...header, lines: [], added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    if (line.startsWith(PATCH_MOVE_TO)) {
      if (current) current.movedTo = line.slice(PATCH_MOVE_TO.length).trim() || undefined;
      continue;
    }
    if (line.startsWith('*** ') || line === '***' || current === null) continue;

    if (line === '@@' || line.startsWith('@@ ')) {
      current.lines.push({ kind: 'marker', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', text: line.slice(1) });
      current.added += 1;
      continue;
    }
    if (current.op === 'update') {
      if (line.startsWith('-')) {
        current.lines.push({ kind: 'del', text: line.slice(1) });
        current.removed += 1;
      } else {
        current.lines.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line });
      }
    }
  }

  for (const file of files) file.lines = addIntraLineEmphasis(file.lines);
  return files.length > 0 ? { files } : null;
}

function parsePatchFileHeader(line: string): { op: FileChangeOp; path: string } | null {
  const headers: Array<[string, FileChangeOp]> = [
    [PATCH_ADD_FILE, 'create'],
    [PATCH_UPDATE_FILE, 'update'],
    [PATCH_DELETE_FILE, 'delete'],
  ];
  for (const [prefix, op] of headers) {
    if (!line.startsWith(prefix)) continue;
    const path = line.slice(prefix.length).trim();
    if (path.length === 0) return null;
    return { op, path };
  }
  return null;
}

function countKind(lines: DiffPreviewLine[], kind: DiffPreviewLineKind): number {
  return lines.reduce((count, line) => (line.kind === kind ? count + 1 : count), 0);
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * Standard LCS line diff between two texts. Shared prefix/suffix lines are
 * stripped first so the quadratic table only covers the changed middle.
 *
 * Exported because comparing two versions of the same file is not unique to
 * tool calls — the library's instance comparison renders through the same
 * pipeline, and a second diff implementation would drift from this one.
 *
 * // Usage: const lines = diffTextLines(before, after);
 */
export function diffTextLines(oldText: string, newText: string): DiffPreviewLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);

  const middle =
    oldMid.length * newMid.length > LINE_DIFF_CELL_BUDGET
      ? [
          ...oldMid.map<DiffPreviewLine>((text) => ({ kind: 'del', text })),
          ...newMid.map<DiffPreviewLine>((text) => ({ kind: 'add', text })),
        ]
      : lcsDiff(oldMid, newMid);

  return collapseContext([
    ...oldLines.slice(0, prefix).map<DiffPreviewLine>((text) => ({ kind: 'context', text })),
    ...addIntraLineEmphasis(middle),
    ...oldLines
      .slice(oldLines.length - suffix)
      .map<DiffPreviewLine>((text) => ({ kind: 'context', text })),
  ]);
}

/**
 * Drops unchanged runs further than `DIFF_CONTEXT_LINES` from a change, marking
 * each gap with a unified-diff hunk header. A whole-file diff whose change sits
 * near the end would otherwise spend the entire render budget on identical
 * leading lines and show no change at all.
 */
function collapseContext(lines: DiffPreviewLine[]): DiffPreviewLine[] {
  if (!lines.some((line) => line.kind !== 'context')) return [];

  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === 'context') continue;
    const from = Math.max(0, i - DIFF_CONTEXT_LINES);
    const to = Math.min(lines.length - 1, i + DIFF_CONTEXT_LINES);
    for (let j = from; j <= to; j++) keep[j] = true;
  }

  // 1-indexed positions on each side, advanced as the walk consumes lines.
  let oldLine = 1;
  let newLine = 1;
  const collapsed: DiffPreviewLine[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!keep[index]) {
      // Only context lines are ever dropped, so both sides advance together.
      oldLine += 1;
      newLine += 1;
      index += 1;
      continue;
    }

    const runStart = index;
    const oldStart = oldLine;
    const newStart = newLine;
    let oldCount = 0;
    let newCount = 0;
    while (index < lines.length && keep[index]) {
      if (lines[index].kind !== 'add') {
        oldLine += 1;
        oldCount += 1;
      }
      if (lines[index].kind !== 'del') {
        newLine += 1;
        newCount += 1;
      }
      index += 1;
    }

    // A run starting at the top had nothing elided before it, so it needs no header.
    if (runStart > 0) {
      collapsed.push({
        kind: 'marker',
        text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      });
    }
    collapsed.push(...lines.slice(runStart, index));
  }
  return collapsed;
}

/**
 * Marks, inside each paired deletion/addition line, the span that actually
 * changed, so a one-identifier edit to a long line reads at a glance.
 *
 * A run of consecutive `del` lines directly followed by a run of `add` lines of
 * the same length is paired line by line (the first deleted with the first
 * added, and so on). Runs of unequal length are left alone: with no way to say
 * which line replaced which, a guess would highlight unrelated text. Each pair
 * keeps its common prefix and suffix and emphasizes what lies between, which is
 * a single span per line; no diff of the characters is computed.
 *
 * Bounded so a huge diff stays linear: at most `INTRA_LINE_MAX_PAIRS` pairs are
 * examined, and a pair with a line over `INTRA_LINE_MAX_LINE_LENGTH` is skipped.
 * Returns new line objects for the lines it touches and never mutates its input.
 *
 * // Usage: const marked = addIntraLineEmphasis(lcsDiff(oldLines, newLines));
 */
export function addIntraLineEmphasis(lines: DiffPreviewLine[]): DiffPreviewLine[] {
  let pairsLeft = INTRA_LINE_MAX_PAIRS;
  let result: DiffPreviewLine[] | null = null;
  let index = 0;
  while (index < lines.length && pairsLeft > 0) {
    if (lines[index].kind !== 'del') {
      index += 1;
      continue;
    }
    const deletedEnd = runEnd(lines, index, 'del');
    const addedEnd = runEnd(lines, deletedEnd, 'add');
    const runLength = deletedEnd - index;
    if (runLength === addedEnd - deletedEnd) {
      for (let offset = 0; offset < runLength && pairsLeft > 0; offset++) {
        pairsLeft -= 1;
        const deletedAt = index + offset;
        const addedAt = deletedEnd + offset;
        const marked = emphasizePair(lines[deletedAt].text, lines[addedAt].text);
        if (!marked) continue;
        result ??= lines.slice();
        if (marked.deleted) result[deletedAt] = { ...lines[deletedAt], emphasis: marked.deleted };
        if (marked.added) result[addedAt] = { ...lines[addedAt], emphasis: marked.added };
      }
    }
    index = addedEnd;
  }
  return result ?? lines;
}

/** Index just past the run of `kind` lines that starts at `from`. */
function runEnd(lines: DiffPreviewLine[], from: number, kind: DiffPreviewLineKind): number {
  let end = from;
  while (end < lines.length && lines[end].kind === kind) end += 1;
  return end;
}

/**
 * The changed span of each side of a replaced line, or `null` when nothing is
 * worth marking: a line is over the length cap, the two share no prefix or
 * suffix (the whole line changed, so emphasis would add nothing), or they are
 * identical. A side whose changed span is empty (a pure insertion or removal)
 * gets no emphasis.
 */
function emphasizePair(
  deletedText: string,
  addedText: string
): { deleted?: DiffLineEmphasis; added?: DiffLineEmphasis } | null {
  if (
    deletedText.length > INTRA_LINE_MAX_LINE_LENGTH ||
    addedText.length > INTRA_LINE_MAX_LINE_LENGTH
  ) {
    return null;
  }

  const shorter = Math.min(deletedText.length, addedText.length);
  let prefix = 0;
  while (prefix < shorter && deletedText[prefix] === addedText[prefix]) prefix += 1;
  // A shared leading half of a surrogate pair would cut an astral character in
  // two, so the pair joins the changed span instead.
  if (prefix > 0 && isHighSurrogate(deletedText.charCodeAt(prefix - 1))) prefix -= 1;

  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    deletedText[deletedText.length - 1 - suffix] === addedText[addedText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (suffix > 0 && isLowSurrogate(deletedText.charCodeAt(deletedText.length - suffix))) {
    suffix -= 1;
  }

  if (prefix + suffix === 0) return null;
  const deleted = { start: prefix, end: deletedText.length - suffix };
  const added = { start: prefix, end: addedText.length - suffix };
  return {
    deleted: deleted.end > deleted.start ? deleted : undefined,
    added: added.end > added.start ? added : undefined,
  };
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function lcsDiff(oldLines: string[], newLines: string[]): DiffPreviewLine[] {
  const rows = oldLines.length;
  const cols = newLines.length;
  // lcs[i][j] = LCS length of oldLines[i..] vs newLines[j..].
  const lcs: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0)
  );
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i][j] =
        oldLines[i] === newLines[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: DiffPreviewLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ kind: 'context', text: oldLines[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ kind: 'del', text: oldLines[i] });
      i += 1;
    } else {
      lines.push({ kind: 'add', text: newLines[j] });
      j += 1;
    }
  }
  while (i < rows) {
    lines.push({ kind: 'del', text: oldLines[i] });
    i += 1;
  }
  while (j < cols) {
    lines.push({ kind: 'add', text: newLines[j] });
    j += 1;
  }
  return lines;
}

/** The slice of a message part the latest-mutation lookup reads. */
type FileChangePartLike = { type: string; name?: string; toolCallId?: string };

/**
 * Returns the toolCallId of the last previewable file-mutation call in a
 * message's parts. The feed-wide lookup below is what the collapse_older
 * display mode uses; this one is its per-message fallback.
 *
 * // Usage: const latestId = findLatestFileChangeId(parts);
 */
export function findLatestFileChangeId(parts: ReadonlyArray<FileChangePartLike>): string | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type !== 'tool_call') continue;
    if (typeof part.name !== 'string' || !FILE_CHANGE_TOOLS.has(part.name)) continue;
    return part.toolCallId ?? null;
  }
  return null;
}

/**
 * Returns the toolCallId of the last file-mutation call anywhere in a
 * transcript, so the collapse_older display mode can keep exactly one diff card
 * open for the whole conversation. Messages are chronological; the scan walks
 * back from the newest and stops at the first message that holds a mutation.
 *
 * It reads the stored parts as they are: a tool call is never merged or
 * rewritten by part normalization, and a legacy message with no parts has none.
 *
 * // Usage: const latestId = findLatestFileChangeIdInFeed(messages);
 */
export function findLatestFileChangeIdInFeed(
  messages: ReadonlyArray<{ parts?: ReadonlyArray<FileChangePartLike> | null }>
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const latestInMessage = findLatestFileChangeId(messages[i].parts ?? []);
    if (latestInMessage !== null) return latestInMessage;
  }
  return null;
}
