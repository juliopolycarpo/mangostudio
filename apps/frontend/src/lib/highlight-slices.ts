import { scheduleIdle } from '@/features/chat/transcript-read-ahead';

/**
 * How long the first draw of a code block may colour lines before it hands the rest to idle
 * slices. A long task is anything over 50 ms, and the draw also serializes the block and the
 * browser parses it, so the tokenizer gets about half.
 */
export const HIGHLIGHT_FIRST_SLICE_MS = 20;

/**
 * The same for each slice after the first draw. A warm slice is this long plus up to one batch
 * of tokenizing past it, plus about 5 ms to swap the lines; 20 keeps that under 50 ms where 30
 * mostly does and 40 does not (13 long tasks in a 2,000-line block, against 6).
 */
export const HIGHLIGHT_SLICE_MS = 20;

/**
 * The longest a slice waits for an idle moment. The browser's idle periods come about once per
 * frame, which stretched colouring a 2,000-line block from 1.7 s to 2.0 s against waiting only a
 * millisecond: the slices then run back to back, each its own task, with a frame and any input
 * handled between them. Where there is no idle callback a timer of this length stands in.
 */
export const HIGHLIGHT_SLICE_IDLE_TIMEOUT_MS = 1;

/** Lines in each group of a long block (`groupedLinesHtml`); also the batch a slice tokenizes between clock reads. */
export const HIGHLIGHT_GROUP_LINES = 16;

/**
 * The most lines one slice brings a block that is behind the highlighter's session, which other
 * blocks with the same text moved on. Those lines are already coloured, so a slice of them costs
 * a patch and no tokenizing; this keeps the patch near the size of a normal slice.
 */
export const HIGHLIGHT_CATCH_UP_LINES = 256;

/** A block of this many lines or fewer is drawn as flat lines, with no groups. */
export const HIGHLIGHT_UNGROUPED_MAX_LINES = 64;

/** The class of a group's element; `markdown-content.css` gives it its containment. */
export const HIGHLIGHT_GROUP_CLASS = 'code-line-group';

/** Whether a block of `lineCount` lines is drawn in groups (and patched by group). */
export function isGroupedBlock(lineCount: number): boolean {
  return lineCount > HIGHLIGHT_UNGROUPED_MAX_LINES;
}

/**
 * The inside of a long block's `<code>`: its serialized lines in groups of `HIGHLIGHT_GROUP_LINES`,
 * each in a block element that contains its layout. Swapping the lines of one group then lays out
 * that group, where one flat `<code>` lays out the whole block each time (10-25 ms for 2,000 lines).
 *
 * The text is the flat block's, character for character: every group but the last ends with the
 * line break that the flat block has between its lines, so `textContent`, a selection across
 * groups and a copy give the same text, and a group's last line break does not draw an empty line.
 */
// Usage: htmlFromLines([groupedLinesHtml(lines)], options)
export function groupedLinesHtml(lines: readonly string[]): string {
  let html = '';
  for (let from = 0; from < lines.length; from += HIGHLIGHT_GROUP_LINES) {
    const end = Math.min(lines.length, from + HIGHLIGHT_GROUP_LINES);
    const lineBreak = end < lines.length ? '\n' : '';
    html += `<span class="${HIGHLIGHT_GROUP_CLASS}">${lines.slice(from, end).join('\n')}${lineBreak}</span>`;
  }
  return html;
}

/**
 * One more stretch of a block that was drawn with only its first lines coloured: the HTML of
 * the lines that changed, so the page swaps those lines and leaves the rest of the block alone.
 */
export interface HighlightSlice {
  /** Index of the first line in `lineHtml`. */
  readonly fromLine: number;
  /** One serialized `<span class="line">` per line, from `fromLine` on. */
  readonly lineHtml: readonly string[];
  /** Lines in the whole block, so the caller can tell that the block on screen is the one sliced. */
  readonly lineCount: number;
  /** True when no more slices will follow: the block is finished, or the highlighter will not go further. */
  readonly done: boolean;
}

/** A block on screen that has lines still to colour. */
export interface SlicedBlock {
  /** The `<pre>` showing the block now. A slice is only written into this element. */
  readonly pre: Element;
  /**
   * The next slice of the block for a `<pre>` that has its lines before `fromLine` coloured: about
   * `budgetMs` more of tokenizing, or lines another block with the same text coloured already.
   * Null when there is nothing to continue or the tokenizer stopped.
   */
  readonly advance: (budgetMs: number, fromLine: number) => HighlightSlice | null;
  /** Whether the highlighter still has lines to colour for this text (false once a block with the same text finished it). */
  readonly isPending: () => boolean;
  /** After a null slice: whether the highlighter will take one more try (a stop on the time limit gets one). */
  readonly canRetryAfterStop: () => boolean;
}

/**
 * The lines at the start of `pre` that are coloured or empty: where the slices of a block drawn
 * partly begin. A line is plain when it holds a token with no style, so this never passes a
 * line that needs colour; it can stop early, and a slice written over a coloured line is the
 * same line again.
 */
// Usage: const from = colouredLinesIn(pre);
export function colouredLinesIn(pre: Element): number {
  const code = pre.querySelector('code');
  if (!code) return 0;
  const lines = code.querySelectorAll('.line');
  const plainLine = code.querySelector('.line > span:not([style])')?.parentElement;
  return plainLine ? Array.prototype.indexOf.call(lines, plainLine) : lines.length;
}

/**
 * Swaps the lines of a drawn code block for the ones in `slice`. The block keeps the rest of its
 * nodes, so a slice costs the lines it carries and not the block, which is what the whole-block
 * replacement costs (64 ms for 2,000 lines). A long block is in groups (`groupedLinesHtml`), so
 * the lines are found inside their groups. Returns false, and writes nothing, when `pre` is
 * not the block the slice was made for: it left the page, or it is plain text with no line
 * elements, or its line count differs.
 */
// Usage: if (!patchCodeLines(pre, slice)) redrawTheBlock();
export function patchCodeLines(pre: Element, slice: HighlightSlice): boolean {
  const code = pre.querySelector('code');
  if (!pre.isConnected || !code) return false;
  const current = code.children;
  const grouped = isGroupedBlock(slice.lineCount);
  const childCount = grouped ? Math.ceil(slice.lineCount / HIGHLIGHT_GROUP_LINES) : slice.lineCount;
  if (current.length !== childCount) return false;
  if (slice.lineHtml.length === 0) return true;

  const lineAt = (index: number): Element | undefined =>
    grouped
      ? current[Math.floor(index / HIGHLIGHT_GROUP_LINES)]?.children[index % HIGHLIGHT_GROUP_LINES]
      : current[index];
  const scratch = pre.ownerDocument.createElement('code');
  scratch.innerHTML = slice.lineHtml.join('\n');
  const replacements = [...scratch.children];
  if (replacements.length !== slice.lineHtml.length) return false;
  const last = slice.fromLine + replacements.length - 1;
  if (
    !lineAt(slice.fromLine)?.classList.contains('line') ||
    !lineAt(last)?.classList.contains('line')
  ) {
    return false;
  }
  for (const [offset, replacement] of replacements.entries()) {
    lineAt(slice.fromLine + offset)?.replaceWith(replacement);
  }
  return true;
}

/**
 * Colours the blocks that were drawn partly, one slice per idle callback, so no task holds the
 * main thread longer than one slice. A slice that lands is written into its block alone
 * (`patchCodeLines`); the message around it is not drawn again. A block that cannot take a patch
 * is still coloured to the end, and `onRedraw` runs once afterwards so the caller draws it from
 * the highlighter's cache.
 *
 * A slice the tokenizer stopped on its time limit is asked for once more after an idle yield,
 * the same single retry a block gets when the first draw stops.
 *
 * @returns a function that cancels what has not run yet. Call it on unmount and when the content
 *   changes: the blocks it was given are no longer the ones on screen.
 */
// Usage: const cancel = continueHighlightsInSlices(blocks, redrawMessage);
export function continueHighlightsInSlices(
  blocks: readonly SlicedBlock[],
  onRedraw: () => void
): () => void {
  let cancelPending: (() => void) | undefined;
  let cancelled = false;
  let needsRedraw = false;

  const finish = (): void => {
    if (needsRedraw && !cancelled) onRedraw();
  };

  // The line each block on screen has reached. The highlighter's session is shared by every block
  // with the same text, so its own progress says nothing about what this `<pre>` shows.
  const nextLines = new Map<SlicedBlock, number>();

  const runBlock = (index: number): void => {
    const block = blocks[index];
    if (block === undefined) {
      finish();
      return;
    }
    cancelPending = scheduleIdle(() => {
      if (cancelled) return;
      // Finished, or given up on, through another block with the same text: this one is plain
      // from where it stopped, and only a draw from the highlighter's cache colours it.
      if (!block.isPending() && !block.canRetryAfterStop()) {
        needsRedraw = true;
        runBlock(index + 1);
        return;
      }
      const from = nextLines.get(block) ?? colouredLinesIn(block.pre);
      const slice = block.advance(HIGHLIGHT_SLICE_MS, from);
      if (slice === null) {
        nextLines.set(block, from);
        runBlock(block.canRetryAfterStop() ? index : index + 1);
        return;
      }
      const patched = patchCodeLines(block.pre, slice);
      if (!patched) needsRedraw = true;
      nextLines.set(block, slice.fromLine + slice.lineHtml.length);
      runBlock(slice.done ? index + 1 : index);
    }, HIGHLIGHT_SLICE_IDLE_TIMEOUT_MS);
  };
  runBlock(0);

  return () => {
    cancelled = true;
    cancelPending?.();
  };
}
