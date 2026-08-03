/**
 * Builds connected MCP clients from the config the hub sends down. This file
 * (plus its siblings in `services/mcp/`) is the only place allowed to import
 * `@modelcontextprotocol/sdk`; everything else consumes {@link McpClientHandle}.
 *
 * The server runs here — a stdio server is a child of this process, an HTTP
 * server is dialed from this machine — which is the point: a URL that only
 * resolves inside a WSL distribution or on a remote host now resolves.
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
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ElicitRequestSchema,
  type ElicitResult,
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { writeRuntimeDiagnostic } from '../../diagnostics';
import type {
  RuntimeMcpCallResult,
  RuntimeMcpResourceContents,
  RuntimeMcpSecrets,
  RuntimeMcpServerConfig,
} from '../../methods';
import { flattenMcpContent, normalizeMcpContent } from './content-mapping';
import { flattenElicitationSchema } from './elicitation-schema';
import { buildStdioEnv } from './stdio-env';
import {
  type McpClientHandle,
  McpConnectionError,
  type McpElicitationRequest,
  type McpElicitationResult,
  type McpRequestOptions,
  type McpServerCapabilities,
} from './types';

/** Request cap applied when neither the call nor the server row sets one. */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

interface QueuedToolCall {
  enqueuedAt: number;
  /** Whether anything was ahead of this call; a 0 ms wait is not the same fact. */
  contended: boolean;
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
    return new Promise<ToolCallSlot>((resolve, reject) => {
      const entry: QueuedToolCall = {
        enqueuedAt: Date.now(),
        contended: this.active || this.waiting.length > 0,
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
      this.drain();
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
        this.active = false;
        this.drain();
      },
    };
  }

  private drain(): void {
    if (this.active) return;
    const next = this.waiting.shift();
    if (!next) return;
    this.active = true;
    next.signal?.removeEventListener('abort', next.onAbort);
    next.resolve(this.createSlot(next.contended, Date.now() - next.enqueuedAt));
  }
}

export interface ConnectMcpClientOptions {
  /** Release string reported to the server during `initialize`. */
  runtimeVersion: string;
  /** Hub-held credentials for this session; kept in memory, never persisted. */
  secrets?: RuntimeMcpSecrets;
  /**
   * Transport override for tests; bypasses stdio spawning and HTTP dialing.
   * Returning `null` declines this server and falls back to the real
   * transport, so a fixture installed by one suite cannot hijack another's.
   */
  createTransport?: (config: RuntimeMcpServerConfig) => Promise<Transport | null>;
  /** Cancels an in-flight connect; closes a partial transport when aborted. */
  signal?: AbortSignal;
  /** Fires once when the session drops out from under us (crash, socket close). */
  onSessionClosed?: () => void;
  /** Fires when the server announces `notifications/tools/list_changed`. */
  onToolListChanged?: () => void;
  /**
   * Carries a mid-call `elicitation/create` up to the hub, which owns the
   * pending registry and the chat surface that answers it.
   */
  requestElicitation?: (request: McpElicitationRequest) => Promise<McpElicitationResult>;
}

export interface WrapMcpClientOptions
  extends Pick<
    ConnectMcpClientOptions,
    'onSessionClosed' | 'onToolListChanged' | 'requestElicitation'
  > {
  /** Server row id, echoed on every elicitation so the hub can route it. */
  serverId: string;
  /** Server slug shown on the elicitation card. */
  serverSlug: string;
}

/**
 * Connects to an MCP server and returns the project-owned handle.
 * // Usage: const handle = await connectMcpClient(config, { runtimeVersion })
 */
export async function connectMcpClient(
  config: RuntimeMcpServerConfig,
  options: ConnectMcpClientOptions
): Promise<McpClientHandle> {
  options.signal?.throwIfAborted();
  const override = await options.createTransport?.(config);
  options.signal?.throwIfAborted();
  const client = override
    ? await connectOverride(config, options, override)
    : config.transport === 'stdio'
      ? await connectStdio(config, options)
      : await connectHttp(config, options);
  if (options.signal?.aborted) {
    await client.close().catch(() => undefined);
    options.signal.throwIfAborted();
  }
  return wrapMcpClient(client, config, {
    serverId: config.id,
    serverSlug: config.slug,
    ...(options.onSessionClosed ? { onSessionClosed: options.onSessionClosed } : {}),
    ...(options.onToolListChanged ? { onToolListChanged: options.onToolListChanged } : {}),
    ...(options.requestElicitation ? { requestElicitation: options.requestElicitation } : {}),
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

function createClient(runtimeVersion: string): Client {
  return new Client(
    { name: 'mangostudio', version: runtimeVersion },
    { capabilities: { elicitation: { form: {} } } }
  );
}

async function connectOverride(
  config: RuntimeMcpServerConfig,
  options: ConnectMcpClientOptions,
  transport: Transport
): Promise<Client> {
  const client = createClient(options.runtimeVersion);
  try {
    await connectClient(client, transport, options.signal);
  } catch (error) {
    throw toConnectionError(config, error);
  }
  return client;
}

async function connectStdio(
  config: RuntimeMcpServerConfig,
  options: ConnectMcpClientOptions
): Promise<Client> {
  if (!config.command?.trim()) {
    throw new McpConnectionError(`MCP server "${config.slug}" has no command configured.`);
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: [...config.args],
    env: buildStdioEnv({ ...config.env, ...options.secrets?.env }),
    stderr: 'ignore',
  });

  const client = createClient(options.runtimeVersion);
  try {
    await connectClient(client, transport, options.signal);
  } catch (error) {
    throw toConnectionError(config, error);
  }
  return client;
}

async function connectHttp(
  config: RuntimeMcpServerConfig,
  options: ConnectMcpClientOptions
): Promise<Client> {
  if (!config.url) {
    throw new McpConnectionError(`MCP server "${config.slug}" has no URL configured.`);
  }

  const headers = { ...options.secrets?.headers };
  const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;

  const client = createClient(options.runtimeVersion);
  try {
    await connectClient(
      client,
      new StreamableHTTPClientTransport(new URL(config.url), { requestInit }),
      options.signal
    );
    return client;
  } catch (error) {
    if (!shouldFallBackToSse(error)) throw toConnectionError(config, error);
  }

  const sseClient = createClient(options.runtimeVersion);
  try {
    await connectClient(
      sseClient,
      new SSEClientTransport(new URL(config.url), { requestInit }),
      options.signal
    );
    return sseClient;
  } catch (error) {
    throw toConnectionError(config, error);
  }
}

/**
 * Connects while honouring cancel: abort closes the client so a partial
 * transport does not linger, and a race that finishes after abort still fails.
 */
async function connectClient(
  client: Client,
  transport: Transport,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  const onAbort = () => {
    void client.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await client.connect(transport);
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function toConnectionError(config: RuntimeMcpServerConfig, error: unknown): McpConnectionError {
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
  config: Pick<RuntimeMcpServerConfig, 'timeoutMs'>,
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
      writeRuntimeDiagnostic('mcp_elicitation_unsupported_mode', {
        serverSlug: callbacks.serverSlug,
        mode: params.mode,
      });
      return { action: 'cancel' };
    }

    // No hub-minted tool call id means nothing upstream can own the answer,
    // and no relay means the hub never asked for one.
    if (!activeToolCall || !callbacks.requestElicitation) {
      writeRuntimeDiagnostic('mcp_elicitation_outside_tool_call', {
        serverSlug: callbacks.serverSlug,
      });
      return { action: 'cancel' };
    }

    const result = await callbacks.requestElicitation({
      serverId: callbacks.serverId,
      serverSlug: callbacks.serverSlug,
      toolCallId: activeToolCall.id,
      message: params.message,
      fields: flattenElicitationSchema(params.requestedSchema),
      ...(activeToolCall.signal ? { signal: activeToolCall.signal } : {}),
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
        const toolCallId = options?.toolCallId?.trim();
        activeToolCall = toolCallId
          ? { id: toolCallId, ...(options?.signal ? { signal: options.signal } : {}) }
          : undefined;
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
      return result.contents.map((entry): RuntimeMcpResourceContents => {
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
      return {
        ...(result.description !== undefined ? { description: result.description } : {}),
        messages: result.messages.map((message) => ({
          role: message.role,
          text: flattenMcpContent(normalizeMcpContent([message.content])),
        })),
      };
    },

    async close() {
      closedByUs = true;
      await client.close();
    },
  };
}

/**
 * Distinguishes why a `callTool` request failed, so the hub can report the
 * precise end-of-life reason for elicitations that were still pending. It runs
 * here because the SDK error types stop at this boundary; the answer travels
 * to the hub as an error detail.
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
    return { action: 'accept', content: { ...result.content } };
  }
  return { action: result.action };
}

function mapCallResult(result: Awaited<ReturnType<Client['callTool']>>): RuntimeMcpCallResult {
  const rawContent = Array.isArray(result.content) ? result.content : [];
  const content = normalizeMcpContent(rawContent);
  return {
    contentText: flattenMcpContent(content),
    isError: result.isError === true,
    rawContentKinds: rawContent.map((block) => block.type),
    content,
  };
}
