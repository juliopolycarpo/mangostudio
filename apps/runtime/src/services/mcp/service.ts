/**
 * Runtime-side MCP session registry. One live session per server id, opened by
 * `mcp.connect` and reused until the hub disconnects it, the server drops, or
 * this host goes away — mirroring what the hub used to do in-process, one
 * machine further out.
 *
 * Sessions are owned by a service instance rather than a module singleton: a
 * hub process runs an in-process host per environment, and two of those must
 * not share a registry.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { writeRuntimeDiagnostic } from '../../diagnostics';
import { RuntimeServiceError } from '../../errors';
import type { RuntimeEventInput, RuntimeHandlerContext } from '../../host';
import type {
  RuntimeMcpAckResult,
  RuntimeMcpCallResult,
  RuntimeMcpCallToolParams,
  RuntimeMcpConnectParams,
  RuntimeMcpConnectResult,
  RuntimeMcpElicitationEvent,
  RuntimeMcpElicitResponseParams,
  RuntimeMcpGetPromptParams,
  RuntimeMcpListPromptsResult,
  RuntimeMcpListResourcesResult,
  RuntimeMcpListToolsResult,
  RuntimeMcpPromptResult,
  RuntimeMcpReadResourceParams,
  RuntimeMcpReadResourceResult,
  RuntimeMcpServerConfig,
  RuntimeMcpServerParams,
  RuntimeMcpSessionEvent,
} from '../../methods';
import { RUNTIME_MCP_ELICITATION_TOPIC, RUNTIME_MCP_SESSION_TOPIC } from '../../methods';
import { classifyMcpCallFailure, connectMcpClient } from './client-factory';
import type { McpClientHandle, McpElicitationRequest, McpElicitationResult } from './types';
import { McpConnectionError } from './types';

/**
 * Substitutes the MCP transport so tests can link an in-memory server without
 * spawning a child or opening a socket. Returning `null` declines the server
 * and lets the real transport handle it — the runner shares modules across
 * test files, so a fixture has to be able to say "not mine".
 */
export type McpTransportFactory = (config: RuntimeMcpServerConfig) => Promise<Transport | null>;

let transportFactoryOverride: McpTransportFactory | null = null;

/** Swaps the MCP transport factory for tests; pass null to restore the real one. */
export function setMcpTransportFactoryForTest(factory: McpTransportFactory | null): void {
  transportFactoryOverride = factory;
}

/** Raised for every MCP failure the hub has to tell apart from a host fault. */
export class McpServiceError extends RuntimeServiceError {
  constructor(
    kind: 'mcp_connection' | 'mcp_call' | 'mcp_session_missing',
    message: string,
    data: Readonly<Record<string, unknown>> = {}
  ) {
    super(kind, message, data);
    this.name = 'McpServiceError';
  }
}

interface McpSession {
  readonly config: RuntimeMcpServerConfig;
  readonly handle: McpClientHandle;
  /** Ids of elicitations this session is still waiting on, for teardown. */
  readonly pendingElicitations: Set<string>;
}

interface PendingElicitation {
  readonly serverId: string;
  readonly settle: (result: McpElicitationResult) => void;
}

export interface McpServiceOptions {
  readonly runtimeVersion: string;
  readonly emit: (event: RuntimeEventInput) => void;
}

export interface McpService {
  connect(
    params: RuntimeMcpConnectParams,
    context?: RuntimeHandlerContext
  ): Promise<RuntimeMcpConnectResult>;
  listTools(params: RuntimeMcpServerParams): Promise<RuntimeMcpListToolsResult>;
  callTool(
    params: RuntimeMcpCallToolParams,
    context: RuntimeHandlerContext
  ): Promise<RuntimeMcpCallResult>;
  listResources(params: RuntimeMcpServerParams): Promise<RuntimeMcpListResourcesResult>;
  readResource(params: RuntimeMcpReadResourceParams): Promise<RuntimeMcpReadResourceResult>;
  listPrompts(params: RuntimeMcpServerParams): Promise<RuntimeMcpListPromptsResult>;
  getPrompt(params: RuntimeMcpGetPromptParams): Promise<RuntimeMcpPromptResult>;
  respondToElicitation(params: RuntimeMcpElicitResponseParams): Promise<RuntimeMcpAckResult>;
  disconnect(params: RuntimeMcpServerParams): Promise<RuntimeMcpAckResult>;
  /** Tears down every session; wired into host close. */
  close(): Promise<void>;
}

export function createMcpService(options: McpServiceOptions): McpService {
  const sessions = new Map<string, McpSession>();
  const pending = new Map<string, PendingElicitation>();
  /** Serializes connect/replace per server id so concurrent connects cannot leak. */
  const connectChains = new Map<string, Promise<unknown>>();
  /** Serializes tool calls per server; the host dispatches requests concurrently. */
  const callToolChains = new Map<string, Promise<unknown>>();

  function publishSession(event: RuntimeMcpSessionEvent): void {
    options.emit({ topic: RUNTIME_MCP_SESSION_TOPIC, payload: event });
  }

  /**
   * Settles a parked question without an answer. Every path that can strand
   * one — the session dropping, the tool call being cancelled, the host
   * closing — routes through here, so a pending entry can never outlive the
   * thing it was waiting on.
   */
  function cancelPending(requestId: string): void {
    pending.get(requestId)?.settle({ action: 'cancel' });
  }

  function cancelSessionElicitations(session: McpSession): void {
    for (const requestId of [...session.pendingElicitations]) cancelPending(requestId);
  }

  function requireSession(serverId: string): McpSession {
    const session = sessions.get(serverId);
    if (!session) {
      throw new McpServiceError(
        'mcp_session_missing',
        `No MCP session is open for server "${serverId}" on this runtime.`,
        { serverId }
      );
    }
    return session;
  }

  async function closeSession(session: McpSession): Promise<void> {
    cancelSessionElicitations(session);
    try {
      await session.handle.close();
    } catch {
      // Session already torn down — closing is best-effort.
    }
  }

  function requestElicitation(request: McpElicitationRequest): Promise<McpElicitationResult> {
    const session = sessions.get(request.serverId);
    if (!session || request.signal?.aborted) return Promise.resolve({ action: 'cancel' });

    const requestId = crypto.randomUUID();
    return new Promise<McpElicitationResult>((resolve) => {
      let settled = false;
      const settle = (result: McpElicitationResult) => {
        if (settled) return;
        settled = true;
        pending.delete(requestId);
        session.pendingElicitations.delete(requestId);
        request.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => settle({ action: 'cancel' });

      pending.set(requestId, { serverId: request.serverId, settle });
      session.pendingElicitations.add(requestId);
      request.signal?.addEventListener('abort', onAbort, { once: true });

      const event: RuntimeMcpElicitationEvent = {
        requestId,
        serverId: request.serverId,
        serverSlug: request.serverSlug,
        toolCallId: request.toolCallId,
        message: request.message,
        fields: request.fields,
      };
      options.emit({ topic: RUNTIME_MCP_ELICITATION_TOPIC, payload: event });
    });
  }

  async function connectOnce(
    params: RuntimeMcpConnectParams,
    context?: RuntimeHandlerContext
  ): Promise<RuntimeMcpConnectResult> {
    context?.signal.throwIfAborted();

    // A reconnect with changed config must not leave the old child running.
    const previous = sessions.get(params.config.id);
    if (previous) {
      sessions.delete(params.config.id);
      await closeSession(previous);
    }

    context?.signal.throwIfAborted();

    let handle: McpClientHandle;
    try {
      handle = await connectMcpClient(params.config, {
        runtimeVersion: options.runtimeVersion,
        ...(params.secrets ? { secrets: params.secrets } : {}),
        ...(transportFactoryOverride ? { createTransport: transportFactoryOverride } : {}),
        ...(context?.signal ? { signal: context.signal } : {}),
        onSessionClosed: () => {
          // Only the session that owns this handle may publish closed — a
          // superseded child's teardown must not drop a newer replacement.
          const session = sessions.get(params.config.id);
          if (!session || session.handle !== handle) return;
          sessions.delete(params.config.id);
          cancelSessionElicitations(session);
          publishSession({ serverId: params.config.id, change: 'closed' });
        },
        onToolListChanged: () => {
          const session = sessions.get(params.config.id);
          if (!session || session.handle !== handle) return;
          publishSession({ serverId: params.config.id, change: 'tool-list-changed' });
        },
        requestElicitation,
      });
    } catch (error) {
      throw toServiceError(error, params.config);
    }

    if (context?.signal.aborted) {
      await closeQuietly(handle);
      context.signal.throwIfAborted();
    }

    sessions.set(params.config.id, {
      config: params.config,
      handle,
      pendingElicitations: new Set(),
    });
    return { capabilities: handle.getCapabilities() };
  }

  return {
    async connect(params, context) {
      const serverId = params.config.id;
      const previous = connectChains.get(serverId) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(() => connectOnce(params, context));
      connectChains.set(serverId, run);
      try {
        return await run;
      } finally {
        if (connectChains.get(serverId) === run) connectChains.delete(serverId);
      }
    },

    async listTools(params) {
      const session = requireSession(params.serverId);
      return { tools: await call(session, () => session.handle.listTools()) };
    },

    callTool(params, context) {
      const session = requireSession(params.serverId);
      const serverId = params.serverId;
      const previous = callToolChains.get(serverId) ?? Promise.resolve();
      const run = previous
        .catch(() => undefined)
        .then(() =>
          call(session, () =>
            session.handle.callTool(
              params.toolName,
              { ...params.args },
              {
                signal: context.signal,
                ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
                ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
              }
            )
          )
        );
      callToolChains.set(serverId, run);
      return run.finally(() => {
        if (callToolChains.get(serverId) === run) callToolChains.delete(serverId);
      });
    },

    async listResources(params) {
      const session = requireSession(params.serverId);
      return { resources: await call(session, () => session.handle.listResources()) };
    },

    async readResource(params) {
      const session = requireSession(params.serverId);
      return { contents: await call(session, () => session.handle.readResource(params.uri)) };
    },

    async listPrompts(params) {
      const session = requireSession(params.serverId);
      return { prompts: await call(session, () => session.handle.listPrompts()) };
    },

    getPrompt(params) {
      const session = requireSession(params.serverId);
      return call(session, () =>
        session.handle.getPrompt(params.promptName, params.args ? { ...params.args } : undefined)
      );
    },

    respondToElicitation(params) {
      const entry = pending.get(params.requestId);
      // A late or duplicate answer is not an error: the question may already
      // have been cancelled by the tool call ending underneath it.
      if (!entry) return Promise.resolve({ ok: true });
      entry.settle(
        params.action === 'accept'
          ? { action: 'accept', content: params.content ?? {} }
          : { action: params.action }
      );
      return Promise.resolve({ ok: true });
    },

    async disconnect(params) {
      const session = sessions.get(params.serverId);
      if (!session) return { ok: true };
      sessions.delete(params.serverId);
      await closeSession(session);
      return { ok: true };
    },

    async close() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map(closeSession));
      for (const requestId of [...pending.keys()]) cancelPending(requestId);
    },
  };
}

async function closeQuietly(handle: McpClientHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Best-effort teardown after an aborted connect.
  }
}

/**
 * Runs one request against a live session, translating whatever the SDK throws
 * into the typed shape the hub branches on.
 */
async function call<T>(session: McpSession, execute: () => Promise<T>): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    // Cancellation is the host's own vocabulary — let it reach the caller as
    // an abort so the dispatcher answers `CANCELLED` rather than `INTERNAL`.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw toServiceError(error, session.config);
  }
}

function toServiceError(error: unknown, config: RuntimeMcpServerConfig): Error {
  if (error instanceof McpConnectionError) {
    return new McpServiceError('mcp_connection', error.message, { serverSlug: config.slug });
  }
  if (error instanceof Error && error.name === 'AbortError') return error;
  const failure = classifyMcpCallFailure(error);
  const message = error instanceof Error ? error.message : String(error);
  if (failure === 'other' && !(error instanceof Error)) {
    writeRuntimeDiagnostic('mcp_call_failed', { serverSlug: config.slug });
  }
  return new McpServiceError('mcp_call', message, {
    serverSlug: config.slug,
    mcpFailure: failure,
  });
}
