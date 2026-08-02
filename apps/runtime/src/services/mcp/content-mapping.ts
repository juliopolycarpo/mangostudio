/**
 * Pure mapping from MCP tool-call content blocks to the shapes the turn
 * pipeline records: an SDK-free normalized block list, and the flattened text
 * result the model sees. Both cross the protocol boundary, so the capping
 * happens here rather than hub-side: a server that dumps a megabyte of text
 * must not put a megabyte on the wire. Persistence of rich blocks (images,
 * binary resources) stays hub-side in `rich-content.ts`.
 */

import type { RuntimeMcpContentBlock } from '../../methods';

/** Structural view of an SDK content block; kept SDK-free on purpose. */
export interface McpContentBlockLike {
  type: string;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
  resource?: unknown;
}

/** Cap on the flattened result so a dumping tool cannot flood the context window. */
export const MCP_RESULT_MAX_BYTES = 64 * 1024;

export const MCP_RESULT_TRUNCATION_MARKER = '\n\n[MCP tool result truncated at 64 KiB]';

const REPLACEMENT_CHAR = '\uFFFD';

/**
 * Converts raw SDK content blocks into the project-owned {@link RuntimeMcpContentBlock}
 * union. Malformed entries degrade to `unknown` instead of throwing so one bad
 * block never poisons the whole result. Oversized text is truncated and oversized
 * binary payloads are dropped so a single block cannot blow the runtime frame.
 *
 * // Usage: const blocks = normalizeMcpContent(result.content)
 */
export function normalizeMcpContent(
  rawBlocks: ReadonlyArray<McpContentBlockLike>
): RuntimeMcpContentBlock[] {
  return rawBlocks.map((block) => {
    if (block.type === 'text' && typeof block.text === 'string') {
      return { type: 'text', text: truncateUtf8(block.text, MCP_RESULT_MAX_BYTES) };
    }
    if (
      (block.type === 'image' || block.type === 'audio') &&
      typeof block.data === 'string' &&
      typeof block.mimeType === 'string'
    ) {
      if (Buffer.byteLength(block.data, 'utf8') > MCP_RESULT_MAX_BYTES) {
        return { type: 'unknown', blockType: block.type, mimeType: block.mimeType };
      }
      return { type: block.type, data: block.data, mimeType: block.mimeType };
    }
    if (block.type === 'resource' && isResourcePayload(block.resource)) {
      const { uri, mimeType, text, blob } = block.resource;
      const cappedText =
        typeof text === 'string' ? { text: truncateUtf8(text, MCP_RESULT_MAX_BYTES) } : undefined;
      const keepBlob =
        typeof blob === 'string' && Buffer.byteLength(blob, 'utf8') <= MCP_RESULT_MAX_BYTES
          ? { blob }
          : undefined;
      if (typeof blob === 'string' && !keepBlob && !cappedText) {
        return {
          type: 'unknown',
          blockType: 'resource',
          ...(typeof mimeType === 'string' ? { mimeType } : {}),
        };
      }
      return {
        type: 'resource',
        uri,
        ...(typeof mimeType === 'string' ? { mimeType } : {}),
        ...cappedText,
        ...keepBlob,
      };
    }
    return {
      type: 'unknown',
      blockType: block.type,
      ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
    };
  });
}

interface ResourcePayloadLike {
  uri: string;
  mimeType?: unknown;
  text?: unknown;
  blob?: unknown;
}

function isResourcePayload(value: unknown): value is ResourcePayloadLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { uri?: unknown }).uri === 'string'
  );
}

/**
 * Flattens normalized blocks into the capped text the model receives: text
 * blocks and text-bearing resources contribute their content, rich blocks a
 * placeholder note so the model knows content existed that it cannot read.
 *
 * // Usage: const text = flattenMcpContent(normalizeMcpContent(result.content))
 */
export function flattenMcpContent(blocks: ReadonlyArray<RuntimeMcpContentBlock>): string {
  return capMcpResultText(blocks.map(blockToFlatText).join('\n\n'));
}

function blockToFlatText(block: RuntimeMcpContentBlock): string {
  if (block.type === 'text') return block.text;
  if (block.type === 'image' || block.type === 'audio') {
    return `[${block.type} content, ${block.mimeType}]`;
  }
  if (block.type === 'resource') {
    if (block.text !== undefined) return block.text;
    const mime = block.mimeType ? `, ${block.mimeType}` : '';
    return `[binary resource ${block.uri}${mime}]`;
  }
  const mime = block.mimeType ? `, ${block.mimeType}` : '';
  return `[unsupported ${block.blockType} content${mime}]`;
}

export function capMcpResultText(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MCP_RESULT_MAX_BYTES) return text;
  const capped = truncateUtf8(text, MCP_RESULT_MAX_BYTES);
  return `${capped}${MCP_RESULT_TRUNCATION_MARKER}`;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buffer = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  // toString drops a trailing partial UTF-8 sequence via the replacement char;
  // strip it so the capped text ends on a clean boundary.
  return stripTrailingReplacementChars(buffer.toString('utf8'));
}

/** Strips trailing U+FFFD without a regex (CodeQL rejects polynomial replace). */
function stripTrailingReplacementChars(text: string): string {
  let end = text.length;
  while (end > 0 && text.endsWith(REPLACEMENT_CHAR, end)) {
    end -= REPLACEMENT_CHAR.length;
  }
  return end === text.length ? text : text.slice(0, end);
}
