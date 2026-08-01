/**
 * Opens an MCP session on the environment that owns the server row and hands
 * back the hub-side handle. Every request is a protocol call; the session, the
 * child process, and the socket all live on the target machine.
 *
 * Three things stay here on purpose: the secret store (one source of truth,
 * delivered at connect and held only in the runtime's memory), the pending
 * elicitation registry (fused to the turn's SSE pipeline), and the tool-call
 * id, which the hub mints and the runtime echoes back so a mid-call question
 * can be routed to the call that caused it.
 */

import {
  DEFAULT_MCP_TIMEOUT_MS,
  RUNTIME_MCP_ELICITATION_TOPIC,
  RUNTIME_MCP_SESSION_TOPIC,
  type RuntimeMcpElicitationEvent,
  type RuntimeMcpSecrets,
  type RuntimeMcpServerConfig,
  type RuntimeMcpSessionEvent,
  RuntimeRemoteError,
} from '@mangostudio/runtime';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { environmentRepository } from '../../modules/environments/infrastructure/environment-repository';
import type { RuntimeClient } from '../runtime-client/runtime-client';
import { getRuntimeClient } from '../runtime-client/runtime-connection-manager';
import { createPendingElicitation } from './elicitation-registry';
import { readMcpHeaders } from './header-secrets';
import {
  assertSecretsMayReachEnvironment,
  type McpSecretTransportTarget,
} from './secret-transport-guard';
import { readMcpSecretEnv } from './stdio-env-secrets';
import {
  type McpClientHandle,
  McpConnectionError,
  type McpRequestOptions,
  type McpServerCapabilities,
  type McpServerRuntimeConfig,
} from './types';

/**
 * Head start the hub's protocol deadline gets over the runtime's own MCP
 * timeout. The two compose: whichever fires first decides the error the user
 * sees, and the runtime's is the one that can name the server, so the hub must
 * always be the slower of the pair.
 */
export const RUNTIME_MCP_CALL_GRACE_MS = 5_000;

/** Cap on delivering one elicitation answer back down; not a user-facing wait. */
const ELICIT_RESPONSE_TIMEOUT_MS = 10_000;

export interface ConnectMcpClientOptions {
  /** Owning user; required so elicitation requests can be auth-scoped. */
  userId: string;
  /** Header lookup override for tests; defaults to the secret-store bundle. */
  resolveHeaders?: (serverId: string) => Promise<Record<string, string>>;
  /** stdio environment-secret lookup override for tests. */
  resolveSecretEnv?: (serverId: string) => Promise<Record<string, string>>;
  /** Environment lookup override for tests; defaults to the owned-row read. */
  resolveTransport?: (environmentId: string) => Promise<McpSecretTransportTarget | null>;
  /** Fires once when the session drops out from under us (crash, socket close). */
  onSessionClosed?: () => void;
  /** Fires when the server announces `notifications/tools/list_changed`. */
  onToolListChanged?: () => void;
}

/**
 * Connects to an MCP server through its environment's runtime.
 * // Usage: const handle = await connectMcpClient(config, { userId })
 */
export async function connectMcpClient(
  config: McpServerRuntimeConfig,
  options: ConnectMcpClientOptions
): Promise<McpClientHandle> {
  const runtime = await resolveRuntime(config, options.userId);
  const secrets = await readSecrets(config, options);
  // Ordered deliberately: refuse before the connect, so a plaintext target
  // never sees the credential even in a request it goes on to reject.
  if (hasSecrets(secrets)) {
    assertSecretsMayReachEnvironment(config.slug, await resolveTransport(config, options));
  }
  const { environmentId, ...wireConfig } = config;

  const capabilities = await connectSession(runtime, wireConfig, secrets, config);
  return createRuntimeMcpHandle({ runtime, config, capabilities, options });
}

async function resolveRuntime(
  config: McpServerRuntimeConfig,
  userId: string
): Promise<RuntimeClient> {
  try {
    return await getRuntimeClient(userId, config.environmentId);
  } catch (error) {
    throw new McpConnectionError(
      `MCP server "${config.slug}" runs on environment "${config.environmentId}", which is unavailable: ${messageOf(error)}`,
      { cause: error }
    );
  }
}

async function readSecrets(
  config: McpServerRuntimeConfig,
  options: ConnectMcpClientOptions
): Promise<RuntimeMcpSecrets> {
  if (config.transport === 'stdio') {
    const env = await (options.resolveSecretEnv ?? readMcpSecretEnv)(config.id);
    return Object.keys(env).length > 0 ? { env } : {};
  }
  const headers = await (options.resolveHeaders ?? readMcpHeaders)(config.id);
  return Object.keys(headers).length > 0 ? { headers } : {};
}

/**
 * The environment record behind a server, for the secret-transport check. Local
 * has no row: it is this process, which is the one place secrets already are.
 */
async function resolveTransport(
  config: McpServerRuntimeConfig,
  options: ConnectMcpClientOptions
): Promise<McpSecretTransportTarget | null> {
  if (options.resolveTransport) return await options.resolveTransport(config.environmentId);
  if (config.environmentId === LOCAL_ENVIRONMENT_ID) return null;
  return await environmentRepository.find(options.userId, config.environmentId);
}

async function connectSession(
  runtime: RuntimeClient,
  wireConfig: RuntimeMcpServerConfig,
  secrets: RuntimeMcpSecrets,
  config: McpServerRuntimeConfig
): Promise<McpServerCapabilities> {
  try {
    const result = await runtime.mcp.connect(
      { config: wireConfig, ...(hasSecrets(secrets) ? { secrets } : {}) },
      { timeoutMs: requestDeadline(config.timeoutMs) }
    );
    return result.capabilities;
  } catch (error) {
    if (error instanceof McpConnectionError) throw error;
    throw new McpConnectionError(
      `Failed to connect to MCP server "${config.slug}": ${messageOf(error)}`,
      { cause: error }
    );
  }
}

function hasSecrets(secrets: RuntimeMcpSecrets): boolean {
  return secrets.env !== undefined || secrets.headers !== undefined;
}

interface RuntimeMcpHandleInput {
  readonly runtime: RuntimeClient;
  readonly config: McpServerRuntimeConfig;
  readonly capabilities: McpServerCapabilities;
  readonly options: ConnectMcpClientOptions;
}

function createRuntimeMcpHandle(input: RuntimeMcpHandleInput): McpClientHandle {
  const { runtime, config, options } = input;
  const serverId = config.id;
  /**
   * Signals of the tool calls currently in flight, by the id the runtime
   * echoes back. A cancelled call has to cancel the question it raised, and
   * the answer arrives on a different path than the call that asked it.
   */
  const activeCalls = new Map<string, AbortSignal | undefined>();
  let closedByUs = false;

  const detach = runtime.onEvent((event) => {
    if (event.topic === RUNTIME_MCP_SESSION_TOPIC) {
      const payload = event.payload as RuntimeMcpSessionEvent;
      if (payload.serverId !== serverId) return;
      if (payload.change === 'tool-list-changed') {
        options.onToolListChanged?.();
        return;
      }
      detach();
      if (!closedByUs) options.onSessionClosed?.();
      return;
    }
    if (event.topic !== RUNTIME_MCP_ELICITATION_TOPIC) return;
    const payload = event.payload as RuntimeMcpElicitationEvent;
    if (payload.serverId !== serverId) return;
    void answerElicitation(payload);
  });

  async function answerElicitation(event: RuntimeMcpElicitationEvent): Promise<void> {
    const signal = activeCalls.get(event.toolCallId);
    const result = await createPendingElicitation({
      userId: options.userId,
      serverId,
      serverSlug: config.slug,
      toolCallId: event.toolCallId,
      message: event.message,
      fields: [...event.fields],
      ...(signal ? { signal } : {}),
    });
    try {
      await runtime.mcp.respondToElicitation(
        {
          requestId: event.requestId,
          action: result.action,
          ...(result.content ? { content: result.content } : {}),
        },
        { timeoutMs: ELICIT_RESPONSE_TIMEOUT_MS }
      );
    } catch {
      // The runtime is gone, so the question it asked is gone with it. The
      // pending entry is already settled; the tool call's own failure is what
      // reports this to the turn.
    }
  }

  /** Marks the session dead when the failure means the far end is unreachable. */
  function noteFailure(error: unknown): never {
    if (isSessionGone(error)) {
      detach();
      if (!closedByUs) options.onSessionClosed?.();
    }
    throw error;
  }

  const deadline = (options?: McpRequestOptions) =>
    requestDeadline(options?.timeoutMs ?? config.timeoutMs);

  return {
    getCapabilities: () => input.capabilities,

    async listTools(callOptions) {
      const result = await runtime.mcp
        .listTools({ serverId }, requestOptions(callOptions, deadline(callOptions)))
        .catch(noteFailure);
      return [...result.tools];
    },

    async callTool(name, args, callOptions) {
      const toolCallId = callOptions?.toolCallId?.trim();
      if (toolCallId) activeCalls.set(toolCallId, callOptions?.signal);
      try {
        return await runtime.mcp
          .callTool(
            {
              serverId,
              toolName: name,
              args,
              ...(toolCallId ? { toolCallId } : {}),
              ...(callOptions?.timeoutMs !== undefined
                ? { timeoutMs: callOptions.timeoutMs }
                : config.timeoutMs !== null
                  ? { timeoutMs: config.timeoutMs }
                  : {}),
            },
            requestOptions(callOptions, deadline(callOptions))
          )
          .catch(noteFailure);
      } finally {
        if (toolCallId) activeCalls.delete(toolCallId);
      }
    },

    async listResources(callOptions) {
      const result = await runtime.mcp
        .listResources({ serverId }, requestOptions(callOptions, deadline(callOptions)))
        .catch(noteFailure);
      return [...result.resources];
    },

    async readResource(uri, callOptions) {
      const result = await runtime.mcp
        .readResource({ serverId, uri }, requestOptions(callOptions, deadline(callOptions)))
        .catch(noteFailure);
      return [...result.contents];
    },

    async listPrompts(callOptions) {
      const result = await runtime.mcp
        .listPrompts({ serverId }, requestOptions(callOptions, deadline(callOptions)))
        .catch(noteFailure);
      return [...result.prompts];
    },

    getPrompt(name, args, callOptions) {
      return runtime.mcp
        .getPrompt(
          { serverId, promptName: name, ...(args ? { args } : {}) },
          requestOptions(callOptions, deadline(callOptions))
        )
        .catch(noteFailure);
    },

    async close() {
      closedByUs = true;
      detach();
      try {
        await runtime.mcp.disconnect({ serverId }, { timeoutMs: RUNTIME_MCP_CALL_GRACE_MS });
      } catch {
        // A runtime that is already gone has already dropped the session.
      }
    },
  };
}

function requestOptions(
  callOptions: McpRequestOptions | undefined,
  timeoutMs: number
): { signal?: AbortSignal; timeoutMs: number } {
  return { ...(callOptions?.signal ? { signal: callOptions.signal } : {}), timeoutMs };
}

/**
 * The hub-side deadline for one MCP request: always later than the deadline
 * the runtime applies to the same request, so the timeout the user sees is the
 * one that knows which server stopped answering.
 */
export function requestDeadline(mcpTimeoutMs: number | null | undefined): number {
  return (mcpTimeoutMs ?? DEFAULT_MCP_TIMEOUT_MS) + RUNTIME_MCP_CALL_GRACE_MS;
}

/** True when the failure means the far end is gone, not that a call failed. */
function isSessionGone(error: unknown): boolean {
  if (!(error instanceof RuntimeRemoteError)) return false;
  return error.code === 'RUNTIME_UNAVAILABLE' || error.details?.kind === 'mcp_session_missing';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
