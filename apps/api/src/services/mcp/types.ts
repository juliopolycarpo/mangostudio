/**
 * Hub-side MCP boundary types. The SDK lives in `@mangostudio/runtime` now —
 * a server runs on the environment its row is bound to — so everything here
 * describes the hub's half: which server, on which environment, and the handle
 * shape the turn pipeline and the settings module call through.
 */

import type {
  RuntimeMcpCallResult,
  RuntimeMcpContentBlock,
  RuntimeMcpPromptResult,
  RuntimeMcpResourceContents,
  RuntimeMcpServerCapabilities,
  RuntimeMcpServerConfig,
} from '@mangostudio/runtime';
import type {
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpToolDescriptor,
} from '@mangostudio/shared/mcp';

/**
 * Runtime connection config derived from an `mcp_servers` row (no secrets),
 * plus the environment that hosts the session. `environmentId` never crosses
 * the protocol: it selects which runtime the rest of this is sent to.
 */
export interface McpServerRuntimeConfig extends RuntimeMcpServerConfig {
  readonly environmentId: string;
}

export interface McpRequestOptions {
  /** Per-request cap; falls back to the server row's timeout, then the default. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Provenance for mid-call elicitation cards (namespaced tool call id). */
  toolCallId?: string;
}

export type McpContentBlock = RuntimeMcpContentBlock;
export type McpCallResult = RuntimeMcpCallResult;
export type McpServerCapabilities = RuntimeMcpServerCapabilities;
export type McpResourceContents = RuntimeMcpResourceContents;

/** Live session with one MCP server, hosted by that server's environment. */
export interface McpClientHandle {
  /** Capabilities from the initialize handshake; available without a request. */
  getCapabilities(): McpServerCapabilities;
  listTools(options?: McpRequestOptions): Promise<McpToolDescriptor[]>;
  /** Serialized FIFO per handle so server-initiated requests retain call context. */
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
