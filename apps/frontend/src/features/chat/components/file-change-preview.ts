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

type DiffPreviewLineKind = 'add' | 'del' | 'context' | 'marker';

export interface DiffPreviewLine {
  kind: DiffPreviewLineKind;
  text: string;
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
      const lines = lineDiff(before, args.content);
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

  const lines = lineDiff(args.oldString, args.newString);
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
    const lines = lineDiff(oldSlice, args.content);
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
 * Standard LCS line diff for the small before/after fragments edit_file
 * carries. Shared prefix/suffix lines are stripped first so the quadratic
 * table only covers the changed middle.
 */
function lineDiff(oldText: string, newText: string): DiffPreviewLine[] {
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
    ...middle,
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

/**
 * Returns the toolCallId of the last previewable file-mutation call in a
 * message's parts, used by the collapse_older display mode.
 *
 * // Usage: const latestId = findLatestFileChangeId(parts);
 */
export function findLatestFileChangeId(
  parts: ReadonlyArray<{ type: string; name?: string; toolCallId?: string }>
): string | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type !== 'tool_call') continue;
    if (typeof part.name !== 'string' || !FILE_CHANGE_TOOLS.has(part.name)) continue;
    return part.toolCallId ?? null;
  }
  return null;
}
