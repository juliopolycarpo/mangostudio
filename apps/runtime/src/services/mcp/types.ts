/**
 * Runtime-owned MCP boundary types. Only `services/mcp/**` may import
 * `@modelcontextprotocol/sdk`; the rest of this workspace — and the hub across
 * the protocol — consumes these wrapper shapes, so an SDK bump stays contained
 * to this directory.
 */

import type {
  McpElicitationAction,
  McpElicitationField,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpToolDescriptor,
} from '@mangostudio/shared/mcp';
import type {
  RuntimeMcpCallResult,
  RuntimeMcpPromptResult,
  RuntimeMcpResourceContents,
  RuntimeMcpServerCapabilities,
} from '../../methods';

export type McpServerCapabilities = RuntimeMcpServerCapabilities;

export interface McpRequestOptions {
  /** Per-request cap; falls back to the server row's timeout, then the default. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Provenance for mid-call elicitation cards (namespaced tool call id). */
  toolCallId?: string;
}

/** One mid-tool-call form request, on its way up to the hub. */
export interface McpElicitationRequest {
  readonly serverId: string;
  readonly serverSlug: string;
  readonly toolCallId: string;
  readonly message: string;
  readonly fields: readonly McpElicitationField[];
  /** The tool call's signal: a cancelled call cancels the question with it. */
  readonly signal?: AbortSignal;
}

export interface McpElicitationResult {
  readonly action: McpElicitationAction;
  readonly content?: Readonly<Record<string, string | number | boolean | string[]>>;
}

/** Live session with one MCP server, produced by the client factory. */
export interface McpClientHandle {
  /** Capabilities from the initialize handshake; available without a request. */
  getCapabilities(): McpServerCapabilities;
  listTools(options?: McpRequestOptions): Promise<McpToolDescriptor[]>;
  /** Serialized FIFO per handle so server-initiated requests retain call context. */
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: McpRequestOptions
  ): Promise<RuntimeMcpCallResult>;
  listResources(options?: McpRequestOptions): Promise<McpResourceDescriptor[]>;
  readResource(uri: string, options?: McpRequestOptions): Promise<RuntimeMcpResourceContents[]>;
  listPrompts(options?: McpRequestOptions): Promise<McpPromptDescriptor[]>;
  getPrompt(
    name: string,
    args: Record<string, string> | undefined,
    options?: McpRequestOptions
  ): Promise<RuntimeMcpPromptResult>;
  close(): Promise<void>;
}

/** Raised when a server cannot be reached or rejects the MCP handshake. */
export class McpConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpConnectionError';
  }
}
