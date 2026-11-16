// A fence opens a line with up to three spaces of indent, then three backticks or tildes.
const CODE_FENCE_LINE = /^ {0,3}(?:```|~~~)/m;

/** True when markdown source opens a fenced code block, i.e. will need the highlighter. */
// Usage: contentHasCodeFence('```ts\nlet a;\n```') === true
export function contentHasCodeFence(content: string): boolean {
  return CODE_FENCE_LINE.test(content);
}

/**
 * Starts fetching the highlighter core when markdown holds a fenced block.
 *
 * The renderer chunk is what decides which grammar the block needs, so the
 * highlighter would normally start loading only after that chunk arrived and
 * ran. Asking for both at the same moment takes one request round off the first
 * code block. A failure here is ignored: the renderer asks again with its own
 * error handling.
 */
// Usage: preloadCodeHighlighterFor(message.text);
export function preloadCodeHighlighterFor(content: string): void {
  if (!contentHasCodeFence(content)) return;
  void import('@/lib/shiki').catch(() => undefined);
}
