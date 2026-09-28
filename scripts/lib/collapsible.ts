// Shared Markdown helper for PR comment sections whose length depends on the
// branch: short lists stay readable in place, long ones fold behind a summary.

/** Item count up to which a section renders expanded; one more folds it. */
export const COLLAPSE_THRESHOLD = 5;

/**
 * Wrap `content` in a `<details>` block when `itemCount` exceeds `threshold`,
 * otherwise return it unchanged. Blank lines around the content keep GitHub
 * rendering the inner Markdown.
 * // Usage: collapseWhenLong(commits.length, `${commits.length} commits`, listMarkdown)
 */
export function collapseWhenLong(
  itemCount: number,
  summary: string,
  content: string,
  threshold: number = COLLAPSE_THRESHOLD
): string {
  if (!Number.isInteger(itemCount) || itemCount < 0) {
    throw new Error(
      `collapseWhenLong itemCount must be a non-negative integer, received ${itemCount}`
    );
  }
  if (itemCount <= threshold) return content;
  return ['<details>', `<summary>${summary}</summary>`, '', content, '', '</details>'].join('\n');
}
