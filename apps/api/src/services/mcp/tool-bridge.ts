/**
 * Bridges enabled MCP servers into the agentic turn: lists their tools as
 * namespaced provider tool definitions and executes namespaced calls. MCP
 * tools never enter the global tool registry — the turn pipeline composes
 * them per user on top of the builtins.
 */

import type { McpToolDescriptor } from '@mangostudio/shared/mcp';
import type { Kysely } from 'kysely';
import type { Database, McpServerSelect } from '../../db/types';
import { createDiagnosticLogger } from '../../lib/logger';
import type { ToolDefinition } from '../providers/types';
import { getMcpClient, listMcpToolsCached } from './connection-manager';
import { toMcpRuntimeConfig } from './runtime-config';
import {
  buildMcpToolName,
  MCP_TOOL_NAME_MAX_LENGTH,
  type ParsedMcpToolName,
  parseMcpToolName,
} from './tool-naming';
import type { McpCallResult } from './types';

/** Per-server budget for the lazy connect + listTools during turn resolution. */
const MCP_TOOL_LIST_BUDGET_MS = 3_000;

/** Execution cap when the server row does not configure its own timeout. */
export const MCP_TOOL_EXECUTE_TIMEOUT_MS = 60_000;

const logger = createDiagnosticLogger('mcp-bridge');

/** One server tool resolved for the turn, with provenance for settings UIs. */
export interface McpBridgeTool {
  /** Namespaced `mcp__<slug>__<tool>` name. */
  name: string;
  serverName: string;
  serverSlug: string;
  toolName: string;
  definition: ToolDefinition;
}

export interface ResolvedMcpToolExecution {
  parsed: ParsedMcpToolName;
  server: McpServerSelect;
}

/**
 * Per-server resolution outcome for one turn, with enough provenance for the
 * capability inspector to explain what was skipped and why.
 */
export interface McpBridgeServerSnapshot {
  serverId: string;
  slug: string;
  name: string;
  /** Tools usable this turn (namespaced, within the provider name cap). */
  tools: McpBridgeTool[];
  /** Namespaced names skipped for exceeding {@link MCP_TOOL_NAME_MAX_LENGTH}. */
  overlongToolNames: string[];
  /** False when the server failed to connect or list within the budget. */
  listed: boolean;
  /**
   * True when the turn's machine refuses MCP and no connect was attempted.
   * Distinguishes a refusal we can name from a connection that merely failed.
   */
  runtimeDenied: boolean;
}

/**
 * Which environments a bridge listing covers. Spelled out at every call site
 * rather than defaulted: a turn that forgot to scope itself would silently
 * offer the model tools that run on a machine it is not talking to.
 */
export type McpBridgeScope =
  | { readonly environmentId: string }
  | { readonly allEnvironments: true };

/**
 * Resolves the tools of the user's enabled MCP servers in scope, one snapshot
 * per server. A server bound to another environment is not a rejected turn
 * candidate but an absent one: its session would open on a machine the turn is
 * not talking to, and the model has no use for a tool whose side effects land
 * somewhere else.
 *
 * A server that fails to connect or list within the budget is reported with
 * `listed: false` and logged — it never fails the turn or hides other
 * servers' tools.
 *
 * // Usage: const servers = await listMcpBridgeServers(db, userId, { environmentId })
 */
export async function listMcpBridgeServers(
  db: Kysely<Database>,
  userId: string,
  scope: McpBridgeScope
): Promise<McpBridgeServerSnapshot[]> {
  const rows = await selectEnabledServerRows(db, userId, scope);

  return Promise.all(
    rows.map(async (row) => {
      const snapshot = unlistedSnapshot(row, false);
      try {
        const tools = await withBudget(
          listMcpToolsCached(userId, toMcpRuntimeConfig(row)),
          MCP_TOOL_LIST_BUDGET_MS,
          `MCP server "${row.slug}" did not list tools within ${MCP_TOOL_LIST_BUDGET_MS}ms.`
        );
        const bridged = toBridgeTools(row, tools);
        snapshot.tools = bridged.tools;
        snapshot.overlongToolNames = bridged.overlongToolNames;
        snapshot.listed = true;
      } catch (error) {
        logger.warn('server_tools_unavailable', { serverSlug: row.slug, error });
      }
      return snapshot;
    })
  );
}

/**
 * Snapshots the in-scope servers without connecting to any of them, for a turn
 * whose target machine refuses MCP. The peer answers `mcp.connect` with
 * `RUNTIME_DENIED`, so attempting the listing would spend the per-server budget
 * to learn what consent already told us; the rows exist so the inspector can
 * name the refusing machine instead of reporting a generic failure.
 *
 * // Usage: const servers = await listDeniedMcpBridgeServers(db, userId, { environmentId })
 */
export async function listDeniedMcpBridgeServers(
  db: Kysely<Database>,
  userId: string,
  scope: McpBridgeScope
): Promise<McpBridgeServerSnapshot[]> {
  const rows = await selectEnabledServerRows(db, userId, scope);
  return rows.map((row) => unlistedSnapshot(row, true));
}

function selectEnabledServerRows(
  db: Kysely<Database>,
  userId: string,
  scope: McpBridgeScope
): Promise<McpServerSelect[]> {
  let query = db
    .selectFrom('mcp_servers')
    .selectAll()
    .where('userId', '=', userId)
    .where('enabled', '=', 1);
  if ('environmentId' in scope) {
    query = query.where('environmentId', '=', scope.environmentId);
  }
  return query.orderBy('createdAt', 'asc').execute();
}

function unlistedSnapshot(row: McpServerSelect, runtimeDenied: boolean): McpBridgeServerSnapshot {
  return {
    serverId: row.id,
    slug: row.slug,
    name: row.name,
    tools: [],
    overlongToolNames: [],
    listed: false,
    runtimeDenied,
  };
}

/**
 * Resolves every tool of the user's enabled MCP servers in scope, flattened
 * across servers.
 * // Usage: const tools = await listMcpBridgeTools(db, userId, { environmentId })
 */
export async function listMcpBridgeTools(
  db: Kysely<Database>,
  userId: string,
  scope: McpBridgeScope
): Promise<McpBridgeTool[]> {
  const servers = await listMcpBridgeServers(db, userId, scope);
  return servers.flatMap((server) => server.tools);
}

/**
 * Executes a namespaced MCP tool call against its owning server. Ownership is
 * enforced by the (userId, slug) lookup; a disabled server rejects the call
 * even if the model still holds its definition from an earlier turn.
 *
 * // Usage: const result = await executeMcpTool(db, userId, name, args, { signal })
 */
export async function executeMcpTool(
  db: Kysely<Database>,
  userId: string,
  name: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; toolCallId?: string; environmentId?: string } = {}
): Promise<McpCallResult> {
  const target = await resolveMcpToolExecution(db, userId, name, options.environmentId);
  return executeResolvedMcpTool(userId, target, args, options);
}

/**
 * Resolves and authorizes one namespaced tool against its full owned server
 * row. `environmentId`, when given, is the turn's: a model still holding a
 * definition from a turn on another environment must not be able to reach that
 * machine through it.
 */
export async function resolveMcpToolExecution(
  db: Kysely<Database>,
  userId: string,
  name: string,
  environmentId?: string
): Promise<ResolvedMcpToolExecution> {
  const parsed = parseMcpToolName(name);
  if (!parsed) throw new Error(`Unknown tool: "${name}"`);

  const row = await getMcpServerRowBySlug(db, userId, parsed.serverSlug);
  if (!row) throw new Error(`MCP server "${parsed.serverSlug}" is not configured.`);
  if (row.enabled === 0) throw new Error(`MCP server "${parsed.serverSlug}" is disabled.`);
  if (environmentId !== undefined && row.environmentId !== environmentId) {
    throw new Error(
      `MCP server "${parsed.serverSlug}" is not available on this chat's environment.`
    );
  }

  return { parsed, server: row };
}

/** Executes an already authorized target without repeating its database lookup. */
export async function executeResolvedMcpTool(
  userId: string,
  target: ResolvedMcpToolExecution,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; toolCallId?: string } = {}
): Promise<McpCallResult> {
  if (target.server.userId !== userId || target.server.slug !== target.parsed.serverSlug) {
    throw new Error(`MCP server "${target.parsed.serverSlug}" is not configured.`);
  }
  if (target.server.enabled === 0) {
    throw new Error(`MCP server "${target.parsed.serverSlug}" is disabled.`);
  }

  const handle = await getMcpClient(userId, toMcpRuntimeConfig(target.server));
  return handle.callTool(target.parsed.toolName, args, {
    timeoutMs: target.server.timeoutMs ?? MCP_TOOL_EXECUTE_TIMEOUT_MS,
    signal: options.signal,
    toolCallId: options.toolCallId,
  });
}

/** Owned server row for a namespaced tool name, or undefined. */
export function getMcpServerRowBySlug(
  db: Kysely<Database>,
  userId: string,
  slug: string
): Promise<McpServerSelect | undefined> {
  return db
    .selectFrom('mcp_servers')
    .selectAll()
    .where('userId', '=', userId)
    .where('slug', '=', slug)
    .executeTakeFirst();
}

function toBridgeTools(
  row: McpServerSelect,
  tools: McpToolDescriptor[]
): { tools: McpBridgeTool[]; overlongToolNames: string[] } {
  const bridged: McpBridgeTool[] = [];
  const overlongToolNames: string[] = [];
  for (const tool of tools) {
    const name = buildMcpToolName(row.slug, tool.name);
    if (name.length > MCP_TOOL_NAME_MAX_LENGTH) {
      logger.warn('tool_name_too_long', { serverSlug: row.slug, toolName: tool.name });
      overlongToolNames.push(name);
      continue;
    }
    bridged.push({
      name,
      serverName: row.name,
      serverSlug: row.slug,
      toolName: tool.name,
      definition: {
        name,
        description: `[${row.name}] ${tool.description}`.trim(),
        parameters: normalizeInputSchema(tool.inputSchema),
      },
    });
  }
  return { tools: bridged, overlongToolNames };
}

/** Passes JSON Schema through verbatim; anything malformed becomes a no-arg tool. */
function normalizeInputSchema(inputSchema: unknown): Record<string, unknown> {
  if (inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)) {
    return inputSchema as Record<string, unknown>;
  }
  return { type: 'object', properties: {} };
}

async function withBudget<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
