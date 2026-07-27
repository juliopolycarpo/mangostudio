// A leading BOM is tolerated because `parseMarkdownFrontmatter` trims it away
// (`String.trim` strips U+FEFF), so discovery accepts a BOM-prefixed file and
// the preview offers a mechanical strategy for it. Rejecting it here would fail
// the apply on a source the preview promised was convertible.
const FRONTMATTER_OPENING = /^\uFEFF?[\t ]*---[\t ]*(?:\r\n|\n)/;
const FRONTMATTER_CLOSING = /^[\t ]*---[\t ]*(?:\r\n|\n|$)/gm;

/**
 * Returns the bytes-as-text after a complete frontmatter block without
 * normalizing line endings. Metadata parsing can normalize its own view, but
 * adapters must preserve the Markdown payload exactly.
 */
export function extractFrontmatterBody(content: string): string | undefined {
  const opening = FRONTMATTER_OPENING.exec(content);
  if (!opening) return undefined;

  FRONTMATTER_CLOSING.lastIndex = opening[0].length;
  const closing = FRONTMATTER_CLOSING.exec(content);
  FRONTMATTER_CLOSING.lastIndex = 0;
  if (!closing) return undefined;

  return content.slice(closing.index + closing[0].length);
}

/** Removes the conventional blank line after frontmatter, preserving its EOL style. */
export function removeFrontmatterSeparator(body: string): string {
  if (body.startsWith('\r\n')) return body.slice(2);
  if (body.startsWith('\n')) return body.slice(1);
  return body;
}
