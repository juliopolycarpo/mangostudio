import { resolveLanguageId } from '@/lib/code-languages';

// An opening fence line: up to three spaces of indent, then three backticks or
// tildes, then an info string, then the newline that ends the line. The newline
// is required on purpose: while a reply streams, "```ts" can be all that has
// arrived of a "```tsx" or "```json" fence, and acting on it would download the
// wrong grammar. A backtick fence cannot carry a backtick in its info string.
const COMPLETE_FENCE_OPENING = /^ {0,3}(?:`{3,}([^\n`]*)|~{3,}([^\n]*))\n/gm;

/**
 * True when markdown source holds a fenced block whose info line is complete
 * and names a language the code highlighter supports, i.e. a block that will
 * need the highlighter. A bare fence, an unsupported language and a still
 * streaming info line all answer false.
 */
// Usage: contentNeedsCodeHighlighter('```ts\nlet a;\n```') === true
export function contentNeedsCodeHighlighter(content: string): boolean {
  for (const match of content.matchAll(COMPLETE_FENCE_OPENING)) {
    if (resolveLanguageId(match[1] ?? match[2] ?? '') !== null) return true;
  }
  return false;
}

/**
 * Starts fetching the highlighter core when markdown holds a block it can
 * colour.
 *
 * The renderer chunk is what decides which grammar the block needs, so the
 * highlighter would normally start loading only after that chunk arrived and
 * ran. Asking for both at the same moment takes one request round off the first
 * code block. A failure here is ignored: the renderer asks again with its own
 * error handling.
 */
// Usage: preloadCodeHighlighterFor(message.text);
export function preloadCodeHighlighterFor(content: string): void {
  if (!contentNeedsCodeHighlighter(content)) return;
  void import('@/lib/shiki').catch(() => undefined);
}
