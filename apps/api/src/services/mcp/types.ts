/**
 * Project-owned MCP boundary types. Only `services/mcp/**` may import
 * `@modelcontextprotocol/sdk`; the rest of the codebase consumes these
 * wrapper shapes so an SDK bump stays contained to this directory.
 */

import type { McpToolDescriptor, McpTransport } from '@mangostudio/shared/mcp';

/** Runtime connection config derived from an `mcp_servers` row (no secrets). */
export interface McpServerRuntimeConfig {
  id: string;
  slug: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  timeoutMs: number | null;
}

export interface McpRequestOptions {
  /** Per-request cap; falls back to the server row's timeout, then the default. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Structural, SDK-free view of one tool-result content block. `image`/`audio`
 * data and `resource` blobs stay base64-encoded exactly as the SDK returns
 * them; consumers decide what to persist or inline.
 */
export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string; blob?: string }
  | { type: 'unknown'; blockType: string; mimeType?: string };

/** Tool call outcome: flattened text for the model plus the structured blocks. */
export interface McpCallResult {
  /** Text and text-resource blocks joined with blank lines, capped. */
  contentText: string;
  isError: boolean;
  /** Content block types the server returned (`text`, `image`, `resource`, …). */
  rawContentKinds: string[];
  /** Normalized content blocks for rich mapping (images, resources). */
  content: McpContentBlock[];
}

/** Live session with one MCP server, produced by the client factory. */
export interface McpClientHandle {
  listTools(options?: McpRequestOptions): Promise<McpToolDescriptor[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: McpRequestOptions
  ): Promise<McpCallResult>;
  close(): Promise<void>;
}

/** Raised when a server cannot be reached or rejects the MCP handshake. */
export class McpConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpConnectionError';
  }
}
