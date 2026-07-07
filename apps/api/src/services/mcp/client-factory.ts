/**
 * Builds connected MCP clients from server rows. This file (plus its siblings
 * in `services/mcp/`) is the only place allowed to import
 * `@modelcontextprotocol/sdk`; everything else consumes `McpClientHandle`.
 */

import type { McpToolDescriptor } from '@mangostudio/shared/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { getVersion } from '../../lib/config';
import { flattenMcpContent } from './content-mapping';
import { readMcpHeaders } from './header-secrets';
import { buildStdioEnv } from './stdio-env';
import {
  type McpCallResult,
  type McpClientHandle,
  McpConnectionError,
  type McpRequestOptions,
  type McpServerRuntimeConfig,
} from './types';

/** Request cap applied when neither the call nor the server row sets one. */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

export interface ConnectMcpClientOptions {
  /** Header lookup override for tests; defaults to the secret-store bundle. */
  resolveHeaders?: (serverId: string) => Promise<Record<string, string>>;
  /** Fires once when the session drops out from under us (crash, socket close). */
  onSessionClosed?: () => void;
  /** Fires when the server announces `notifications/tools/list_changed`. */
  onToolListChanged?: () => void;
}

/**
 * Connects to an MCP server and returns the project-owned handle.
 * // Usage: const handle = await connectMcpClient(config)
 */
export async function connectMcpClient(
  config: McpServerRuntimeConfig,
  options: ConnectMcpClientOptions = {}
): Promise<McpClientHandle> {
  const client =
    config.transport === 'stdio' ? await connectStdio(config) : await connectHttp(config, options);
  return wrapMcpClient(client, config, options);
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
  return new Client({ name: 'mangostudio', version: getVersion() });
}

async function connectStdio(config: McpServerRuntimeConfig): Promise<Client> {
  if (!config.command) {
    throw new McpConnectionError(`MCP server "${config.slug}" has no command configured.`);
  }

  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: buildStdioEnv(config.env),
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
  callbacks: Pick<ConnectMcpClientOptions, 'onSessionClosed' | 'onToolListChanged'> = {}
): McpClientHandle {
  let closedByUs = false;
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

  const requestOptions = (options?: McpRequestOptions) => ({
    timeout: options?.timeoutMs ?? config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    signal: options?.signal,
  });

  return {
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
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        requestOptions(options)
      );
      return mapCallResult(result);
    },

    async close() {
      closedByUs = true;
      await client.close();
    },
  };
}

function mapCallResult(result: Awaited<ReturnType<Client['callTool']>>): McpCallResult {
  const content = Array.isArray(result.content) ? result.content : [];
  return {
    contentText: flattenMcpContent(content),
    isError: result.isError === true,
    rawContentKinds: content.map((block) => block.type),
  };
}
