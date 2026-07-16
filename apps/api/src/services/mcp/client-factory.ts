/**
 * Builds connected MCP clients from server rows. This file (plus its siblings
 * in `services/mcp/`) is the only place allowed to import
 * `@modelcontextprotocol/sdk`; everything else consumes `McpClientHandle`.
 */

import type {
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpToolDescriptor,
} from '@mangostudio/shared/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ElicitRequestSchema,
  type ElicitResult,
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getVersion } from '../../lib/config';
import { createDiagnosticLogger } from '../../lib/logger';
import { flattenMcpContent, normalizeMcpContent } from './content-mapping';
import { createPendingElicitation, type McpElicitationResult } from './elicitation-registry';
import { flattenElicitationSchema } from './elicitation-schema';
import { readMcpHeaders } from './header-secrets';
import { buildStdioEnv } from './stdio-env';
import { readMcpSecretEnv } from './stdio-env-secrets';
import {
  type McpCallResult,
  type McpClientHandle,
  McpConnectionError,
  type McpPromptResult,
  type McpRequestOptions,
  type McpResourceContents,
  type McpServerCapabilities,
  type McpServerRuntimeConfig,
} from './types';

/** Request cap applied when neither the call nor the server row sets one. */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

const logger = createDiagnosticLogger('mcp-client');

interface QueuedToolCall {
  enqueuedAt: number;
  signal?: AbortSignal;
  onAbort: () => void;
  resolve: (slot: ToolCallSlot) => void;
}

interface ToolCallSlot {
  queued: boolean;
  queueWaitMs: number;
  release: () => void;
}

/** FIFO gate for callTool only; discovery, resources, and prompts stay parallel. */
class ToolCallQueue {
  private active = false;
  private readonly waiting: QueuedToolCall[] = [];

  acquire(signal?: AbortSignal): Promise<ToolCallSlot> {
    signal?.throwIfAborted();
    if (!this.active) {
      this.active = true;
      return Promise.resolve(this.createSlot(false, 0));
    }

    return new Promise<ToolCallSlot>((resolve, reject) => {
      const entry: QueuedToolCall = {
        enqueuedAt: Date.now(),
        signal,
        onAbort: () => {
          const index = this.waiting.indexOf(entry);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        },
        resolve,
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.waiting.push(entry);
    });
  }

  private createSlot(queued: boolean, queueWaitMs: number): ToolCallSlot {
    let released = false;
    return {
      queued,
      queueWaitMs,
      release: () => {
        if (released) return;
        released = true;
        this.releaseNext();
      },
    };
  }

  private releaseNext(): void {
    const next = this.waiting.shift();
    if (!next) {
      this.active = false;
      return;
    }
    next.signal?.removeEventListener('abort', next.onAbort);
    next.resolve(this.createSlot(true, Date.now() - next.enqueuedAt));
  }
}

export interface ConnectMcpClientOptions {
  /** Owning user; required so elicitation requests can be auth-scoped. */
  userId: string;
  /** Header lookup override for tests; defaults to the secret-store bundle. */
  resolveHeaders?: (serverId: string) => Promise<Record<string, string>>;
  /** stdio environment-secret lookup override for tests. */
  resolveSecretEnv?: (serverId: string) => Promise<Record<string, string>>;
  /** Fires once when the session drops out from under us (crash, socket close). */
  onSessionClosed?: () => void;
  /** Fires when the server announces `notifications/tools/list_changed`. */
  onToolListChanged?: () => void;
}

export interface WrapMcpClientOptions
  extends Pick<ConnectMcpClientOptions, 'onSessionClosed' | 'onToolListChanged' | 'userId'> {
  /** Server row id for pending-elicitation ownership. */
  serverId: string;
  /** Server slug shown on the elicitation card. */
  serverSlug: string;
}

/**
 * Connects to an MCP server and returns the project-owned handle.
 * // Usage: const handle = await connectMcpClient(config)
 */
export async function connectMcpClient(
  config: McpServerRuntimeConfig,
  options: ConnectMcpClientOptions
): Promise<McpClientHandle> {
  const client =
    config.transport === 'stdio'
      ? await connectStdio(config, options)
      : await connectHttp(config, options);
  return wrapMcpClient(client, config, {
    userId: options.userId,
    serverId: config.id,
    serverSlug: config.slug,
    onSessionClosed: options.onSessionClosed,
    onToolListChanged: options.onToolListChanged,
  });
}

/**
 * Spec compat recipe: a modern Streamable HTTP client detects a legacy
 * SSE-only server by the initialize POST failing with a 4xx status.
 */
export function shouldFallBackToSse(error: unknown): boolean {
  return (
    error instanceof StreamableHTTPError &&
    error.code !== undefined &&
    error.code >= 400 &&
    error.code < 500
  );
}

function createClient(): Client {
  return new Client(
    { name: 'mangostudio', version: getVersion() },
    { capabilities: { elicitation: { form: {} } } }
  );
}

async function connectStdio(
  config: McpServerRuntimeConfig,
  options: ConnectMcpClientOptions
): Promise<Client> {
  if (!config.command?.trim()) {
    throw new McpConnectionError(`MCP server "${config.slug}" has no command configured.`);
  }

  const secretEnv = await (options.resolveSecretEnv ?? readMcpSecretEnv)(config.id);
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: buildStdioEnv({ ...config.env, ...secretEnv }),
    stderr: 'ignore',
  });

  const client = createClient();
  try {
    await client.connect(transport);
  } catch (error) {
    throw toConnectionError(config, error);
  }
  return client;
}

async function connectHttp(
  config: McpServerRuntimeConfig,
  options: ConnectMcpClientOptions
): Promise<Client> {
  if (!config.url) {
    throw new McpConnectionError(`MCP server "${config.slug}" has no URL configured.`);
  }

  const headers = await (options.resolveHeaders ?? readMcpHeaders)(config.id);
  const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;

  const client = createClient();
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit }));
    return client;
  } catch (error) {
    if (!shouldFallBackToSse(error)) throw toConnectionError(config, error);
  }

  const sseClient = createClient();
  try {
    await sseClient.connect(new SSEClientTransport(new URL(config.url), { requestInit }));
    return sseClient;
  } catch (error) {
    throw toConnectionError(config, error);
  }
}

function toConnectionError(config: McpServerRuntimeConfig, error: unknown): McpConnectionError {
  const detail = error instanceof Error ? error.message : String(error);
  return new McpConnectionError(`Failed to connect to MCP server "${config.slug}": ${detail}`, {
    cause: error,
  });
}

/**
 * Wraps a connected SDK client in the project-owned handle. Exported so
 * wrapper-contract tests can drive it over the SDK's in-memory transport.
 */
export function wrapMcpClient(
  client: Client,
  config: Pick<McpServerRuntimeConfig, 'timeoutMs'>,
  callbacks: WrapMcpClientOptions
): McpClientHandle {
  let closedByUs = false;
  let activeToolCall: { id: string; signal?: AbortSignal } | undefined;
  const toolCallQueue = new ToolCallQueue();
  client.onclose = () => {
    if (!closedByUs) callbacks.onSessionClosed?.();
  };
  if (callbacks.onToolListChanged) {
    const onToolListChanged = callbacks.onToolListChanged;
    // Servers that never send the notification simply leave the cache warm.
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      onToolListChanged();
    });
  }

  client.setRequestHandler(ElicitRequestSchema, async (request): Promise<ElicitResult> => {
    const params = request.params;
    // Form mode is the only capability we declare; URL (or unknown) modes
    // cancel so servers degrade instead of hanging on an unsupported UI.
    if (params.mode === 'url' || !('requestedSchema' in params)) {
      logger.warn('elicitation_unsupported_mode', {
        serverSlug: callbacks.serverSlug,
        mode: params.mode,
      });
      return { action: 'cancel' };
    }

    if (!activeToolCall) {
      logger.warn('elicitation_outside_tool_call', { serverSlug: callbacks.serverSlug });
      return { action: 'cancel' };
    }

    const result = await createPendingElicitation({
      userId: callbacks.userId,
      serverId: callbacks.serverId,
      serverSlug: callbacks.serverSlug,
      toolCallId: activeToolCall.id,
      message: params.message,
      fields: flattenElicitationSchema(params.requestedSchema),
      signal: activeToolCall.signal,
    });
    return toElicitResult(result);
  });

  const requestOptions = (options?: McpRequestOptions) => ({
    timeout: options?.timeoutMs ?? config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    signal: options?.signal,
  });

  return {
    getCapabilities(): McpServerCapabilities {
      const capabilities = client.getServerCapabilities();
      return {
        tools: capabilities?.tools !== undefined,
        resources: capabilities?.resources !== undefined,
        prompts: capabilities?.prompts !== undefined,
      };
    },

    async listTools(options) {
      const tools: McpToolDescriptor[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools({ cursor }, requestOptions(options));
        for (const tool of page.tools) {
          tools.push({
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },

    async callTool(name, args, options) {
      const slot = await toolCallQueue.acquire(options?.signal);
      try {
        if (slot.queued) {
          logger.debug('tool_call_queue_wait', {
            serverSlug: callbacks.serverSlug,
            queueWaitMs: slot.queueWaitMs,
          });
        }
        const toolCallId = options?.toolCallId?.trim();
        activeToolCall = toolCallId ? { id: toolCallId, signal: options?.signal } : undefined;
        const result = await client.callTool(
          { name, arguments: args },
          undefined,
          requestOptions(options)
        );
        return mapCallResult(result);
      } finally {
        activeToolCall = undefined;
        slot.release();
      }
    },

    async listResources(options) {
      const resources: McpResourceDescriptor[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listResources({ cursor }, requestOptions(options));
        for (const resource of page.resources) {
          resources.push({
            uri: resource.uri,
            name: resource.title ?? resource.name,
            ...(resource.description !== undefined ? { description: resource.description } : {}),
            ...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
            ...(resource.size !== undefined ? { sizeBytes: resource.size } : {}),
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return resources;
    },

    async readResource(uri, options) {
      const result = await client.readResource({ uri }, requestOptions(options));
      return result.contents.map((entry): McpResourceContents => {
        const text = 'text' in entry && typeof entry.text === 'string' ? entry.text : undefined;
        const blob = 'blob' in entry && typeof entry.blob === 'string' ? entry.blob : undefined;
        return {
          uri: entry.uri,
          ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(blob !== undefined ? { blob } : {}),
        };
      });
    },

    async listPrompts(options) {
      const prompts: McpPromptDescriptor[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listPrompts({ cursor }, requestOptions(options));
        for (const prompt of page.prompts) {
          prompts.push({
            name: prompt.name,
            ...(prompt.description !== undefined ? { description: prompt.description } : {}),
            arguments: (prompt.arguments ?? []).map((argument) => ({
              name: argument.name,
              ...(argument.description !== undefined ? { description: argument.description } : {}),
              ...(argument.required !== undefined ? { required: argument.required } : {}),
            })),
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return prompts;
    },

    async getPrompt(name, args, options) {
      const result = await client.getPrompt(
        { name, ...(args ? { arguments: args } : {}) },
        requestOptions(options)
      );
      const prompt: McpPromptResult = {
        ...(result.description !== undefined ? { description: result.description } : {}),
        messages: result.messages.map((message) => ({
          role: message.role,
          text: flattenMcpContent(normalizeMcpContent([message.content])),
        })),
      };
      return prompt;
    },

    async close() {
      closedByUs = true;
      await client.close();
    },
  };
}

/**
 * Distinguishes why a `callTool` request failed, so callers can report the
 * precise end-of-life reason for elicitations that were still pending.
 */
export function classifyMcpCallFailure(error: unknown): 'timeout' | 'server_closed' | 'other' {
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) return 'timeout';
    if (error.code === ErrorCode.ConnectionClosed) return 'server_closed';
  }
  return 'other';
}

function toElicitResult(result: McpElicitationResult): ElicitResult {
  if (result.action === 'accept') {
    return { action: 'accept', content: result.content ?? {} };
  }
  return { action: result.action };
}

function mapCallResult(result: Awaited<ReturnType<Client['callTool']>>): McpCallResult {
  const rawContent = Array.isArray(result.content) ? result.content : [];
  const content = normalizeMcpContent(rawContent);
  return {
    contentText: flattenMcpContent(content),
    isError: result.isError === true,
    rawContentKinds: rawContent.map((block) => block.type),
    content,
  };
}
