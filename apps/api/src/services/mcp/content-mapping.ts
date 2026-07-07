/**
 * Pure mapping from MCP tool-call content blocks to the flat text result the
 * turn pipeline records. v1 keeps text blocks and replaces rich media with a
 * bracketed placeholder; rich content mapping is a planned follow-up.
 */

/** Structural view of an SDK content block; kept SDK-free on purpose. */
export interface McpContentBlockLike {
  type: string;
  text?: unknown;
  mimeType?: unknown;
}

/** Cap on the flattened result so a dumping tool cannot flood the context window. */
export const MCP_RESULT_MAX_BYTES = 64 * 1024;

export const MCP_RESULT_TRUNCATION_MARKER = '\n\n[MCP tool result truncated at 64 KiB]';

/**
 * Joins text blocks with blank lines; non-text blocks contribute a placeholder
 * note so the model knows content existed that it cannot see yet.
 *
 * // Usage: const text = flattenMcpContent(result.content)
 */
export function flattenMcpContent(blocks: ReadonlyArray<McpContentBlockLike>): string {
  const parts = blocks.map((block) => {
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    const mime = typeof block.mimeType === 'string' ? `, ${block.mimeType}` : '';
    return `[unsupported ${block.type} content${mime}]`;
  });
  return capMcpResultText(parts.join('\n\n'));
}

export function capMcpResultText(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MCP_RESULT_MAX_BYTES) return text;
  const buffer = Buffer.from(text, 'utf8').subarray(0, MCP_RESULT_MAX_BYTES);
  // toString drops a trailing partial UTF-8 sequence via the replacement char;
  // strip it so the capped text ends on a clean boundary.
  const capped = buffer.toString('utf8').replace(/�+$/, '');
  return `${capped}${MCP_RESULT_TRUNCATION_MARKER}`;
}
