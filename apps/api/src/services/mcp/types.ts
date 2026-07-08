/**
 * Project-owned MCP boundary types. Only `services/mcp/**` may import
 * `@modelcontextprotocol/sdk`; the rest of the codebase consumes these
 * wrapper shapes so an SDK bump stays contained to this directory.
 */

import type {
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpToolDescriptor,
  McpTransport,
} from '@mangostudio/shared/mcp';

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

/** Feature areas a server advertised during the MCP initialize handshake. */
export interface McpServerCapabilities {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
}

/** One `resources/read` content entry; binary payloads stay base64 in `blob`. */
export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/** A resolved prompt, with each message's content flattened to plain text. */
export interface McpPromptResult {
  description?: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
}

/** Live session with one MCP server, produced by the client factory. */
export interface McpClientHandle {
  /** Capabilities from the initialize handshake; available without a request. */
  getCapabilities(): McpServerCapabilities;
  listTools(options?: McpRequestOptions): Promise<McpToolDescriptor[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: McpRequestOptions
  ): Promise<McpCallResult>;
  listResources(options?: McpRequestOptions): Promise<McpResourceDescriptor[]>;
  readResource(uri: string, options?: McpRequestOptions): Promise<McpResourceContents[]>;
  listPrompts(options?: McpRequestOptions): Promise<McpPromptDescriptor[]>;
  getPrompt(
    name: string,
    args: Record<string, string> | undefined,
    options?: McpRequestOptions
  ): Promise<McpPromptResult>;
  close(): Promise<void>;
}

/** Raised when a server cannot be reached or rejects the MCP handshake. */
export class McpConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpConnectionError';
  }
}
