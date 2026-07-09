/**
 * Lazy per-user MCP connection registry: one client per (userId, serverId),
 * single-flight connects, last-known status tracking, and idle keep-alive
 * (sessions are held until the server row changes or the app shuts down).
 * There is no background retry loop — a failed or dropped session simply
 * reconnects on next use.
 */

import type { McpServerStatus, McpToolDescriptor } from '@mangostudio/shared/mcp';
import { connectMcpClient } from './client-factory';
import type { McpClientHandle, McpRequestOptions, McpServerRuntimeConfig } from './types';

export interface McpRuntimeStatus {
  status: McpServerStatus;
  /** Failure detail when `status` is `error`. */
  error?: string;
}

interface ManagedConnection {
  handle: McpClientHandle | null;
  connectPromise: Promise<McpClientHandle> | null;
  status: McpServerStatus;
  error?: string;
  /** listTools cache for the live session; null until first listing. */
  tools: McpToolDescriptor[] | null;
}

const connections = new Map<string, ManagedConnection>();

type McpClientConnector = typeof connectMcpClient;
let connectorOverride: McpClientConnector | null = null;

/** Swaps the client factory for tests; pass null to restore the real one. */
export function setMcpClientConnectorForTest(connector: McpClientConnector | null): void {
  connectorOverride = connector;
}

function connectionKey(userId: string, serverId: string): string {
  return `${userId}:${serverId}`;
}

/** Last-known status without forcing a connect (listing stays passive). */
export function getMcpRuntimeStatus(userId: string, serverId: string): McpRuntimeStatus {
  const entry = connections.get(connectionKey(userId, serverId));
  if (!entry) return { status: 'disconnected' };
  return { status: entry.status, error: entry.error };
}

/**
 * Returns the live client for a server, connecting on first use. Concurrent
 * callers during a connect share the same in-flight promise.
 * // Usage: const handle = await getMcpClient(userId, config)
 */
export function getMcpClient(
  userId: string,
  config: McpServerRuntimeConfig
): Promise<McpClientHandle> {
  const key = connectionKey(userId, config.id);
  const existing = connections.get(key);
  if (existing?.handle) return Promise.resolve(existing.handle);
  if (existing?.connectPromise) return existing.connectPromise;

  const entry: ManagedConnection = {
    handle: null,
    connectPromise: null,
    status: 'connecting',
    tools: null,
  };
  connections.set(key, entry);

  const connect = connectorOverride ?? connectMcpClient;
  entry.connectPromise = connect(config, {
    userId,
    onSessionClosed: () => {
      // The server dropped the session (crash, socket close): forget the dead
      // handle but keep the entry so status reads `disconnected` until reuse.
      entry.handle = null;
      entry.status = 'disconnected';
      entry.tools = null;
    },
    onToolListChanged: () => {
      entry.tools = null;
    },
  }).then(
    (handle) => {
      entry.handle = handle;
      entry.connectPromise = null;
      entry.status = 'connected';
      entry.error = undefined;
      return handle;
    },
    (error: unknown) => {
      entry.connectPromise = null;
      entry.status = 'error';
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  );
  return entry.connectPromise;
}

/**
 * Lists a server's tools through the per-session cache, connecting on first
 * use. The cache lives on the managed connection, so reconnects and
 * `notifications/tools/list_changed` both invalidate it.
 * // Usage: const tools = await listMcpToolsCached(userId, config)
 */
export async function listMcpToolsCached(
  userId: string,
  config: McpServerRuntimeConfig,
  options?: McpRequestOptions
): Promise<McpToolDescriptor[]> {
  const key = connectionKey(userId, config.id);
  const cached = connections.get(key);
  if (cached?.handle && cached.tools) return cached.tools;

  const handle = await getMcpClient(userId, config);
  const tools = await handle.listTools(options);
  const entry = connections.get(key);
  if (entry?.handle === handle) entry.tools = tools;
  return tools;
}

/**
 * Closes and forgets a server's connection — called when its row is updated,
 * disabled, or deleted so the next use reconnects with fresh config.
 */
export async function disposeMcpServer(userId: string, serverId: string): Promise<void> {
  const key = connectionKey(userId, serverId);
  const entry = connections.get(key);
  if (!entry) return;
  connections.delete(key);

  if (entry.handle) {
    await closeQuietly(entry.handle);
  } else if (entry.connectPromise) {
    // A connect is in flight; close its client once it lands so the stale
    // config's session never lingers. A rejected connect needs no cleanup.
    entry.connectPromise.then(closeQuietly).catch(() => undefined);
  }
}

/** Closes every held connection; wired into server shutdown. */
export async function closeAllMcpClients(): Promise<void> {
  const entries = [...connections.values()];
  connections.clear();
  await Promise.all(entries.map((entry) => (entry.handle ? closeQuietly(entry.handle) : null)));
}

async function closeQuietly(handle: McpClientHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Session already torn down — closing is best-effort.
  }
}
