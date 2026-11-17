import { scheduleIdle } from '@/features/chat/transcript-read-ahead';

/**
 * How long the first draw of a code block may colour lines before it hands the rest to idle
 * slices. A long task is anything over 50 ms, and the draw also serializes the block and the
 * browser parses it, so the tokenizer gets about half.
 */
export const HIGHLIGHT_FIRST_SLICE_MS = 20;

/** The same for each idle slice after the first draw: tokenizing plus swapping the lines on screen. */
export const HIGHLIGHT_SLICE_MS = 10;

/**
 * The longest a slice waits for an idle moment. A page that is never idle (a stream is running)
 * still colours its blocks, one slice at a time; where there is no idle callback a timer of this
 * length stands in.
 */
export const HIGHLIGHT_SLICE_IDLE_TIMEOUT_MS = 100;

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
  /** Colours about `budgetMs` more of the block; null when there is nothing to continue or the tokenizer stopped. */
  readonly advance: (budgetMs: number) => HighlightSlice | null;
  /** After a null slice: whether the highlighter will take one more try (a stop on the time limit gets one). */
  readonly canRetryAfterStop: () => boolean;
}

/**
 * Swaps the lines of a drawn code block for the ones in `slice`. The block keeps the rest of its
 * nodes, so a slice costs the lines it carries and not the block, which is what the whole-block
 * replacement costs (64 ms for 2,000 lines). Returns false, and writes nothing, when `pre` is
 * not the block the slice was made for: it left the page, or it is plain text with no line
 * elements, or its line count differs.
 */
// Usage: if (!patchCodeLines(pre, slice)) redrawTheBlock();
export function patchCodeLines(pre: Element, slice: HighlightSlice): boolean {
  const code = pre.querySelector('code');
  if (!pre.isConnected || !code) return false;
  const current = code.children;
  if (current.length !== slice.lineCount) return false;
  if (slice.lineHtml.length === 0) return true;

  const scratch = pre.ownerDocument.createElement('code');
  scratch.innerHTML = slice.lineHtml.join('\n');
  const replacements = [...scratch.children];
  if (replacements.length !== slice.lineHtml.length) return false;
  const last = slice.fromLine + replacements.length - 1;
  if (
    !current[slice.fromLine]?.classList.contains('line') ||
    !current[last]?.classList.contains('line')
  ) {
    return false;
  }
  for (const [offset, replacement] of replacements.entries()) {
    current[slice.fromLine + offset]?.replaceWith(replacement);
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

  const runBlock = (index: number): void => {
    const block = blocks[index];
    if (block === undefined) {
      finish();
      return;
    }
    cancelPending = scheduleIdle(() => {
      if (cancelled) return;
      const slice = block.advance(HIGHLIGHT_SLICE_MS);
      if (slice === null) {
        runBlock(block.canRetryAfterStop() ? index : index + 1);
        return;
      }
      const patched = patchCodeLines(block.pre, slice);
      if (!patched) needsRedraw = true;
      runBlock(slice.done ? index + 1 : index);
    }, HIGHLIGHT_SLICE_IDLE_TIMEOUT_MS);
  };
  runBlock(0);

  return () => {
    cancelled = true;
    cancelPending?.();
  };
}
