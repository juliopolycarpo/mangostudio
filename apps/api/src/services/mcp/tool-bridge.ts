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
}

/**
 * Resolves the tools of every enabled MCP server, one snapshot per server. A
 * server that fails to connect or list within the budget is reported with
 * `listed: false` and logged — it never fails the turn or hides other
 * servers' tools.
 *
 * // Usage: const servers = await listMcpBridgeServers(db, userId)
 */
export async function listMcpBridgeServers(
  db: Kysely<Database>,
  userId: string
): Promise<McpBridgeServerSnapshot[]> {
  const rows = await db
    .selectFrom('mcp_servers')
    .selectAll()
    .where('userId', '=', userId)
    .where('enabled', '=', 1)
    .orderBy('createdAt', 'asc')
    .execute();

  return Promise.all(
    rows.map(async (row) => {
      const snapshot: McpBridgeServerSnapshot = {
        serverId: row.id,
        slug: row.slug,
        name: row.name,
        tools: [],
        overlongToolNames: [],
        listed: false,
      };
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
 * Resolves every tool of the user's enabled MCP servers, flattened across
 * servers. // Usage: const tools = await listMcpBridgeTools(db, userId)
 */
export async function listMcpBridgeTools(
  db: Kysely<Database>,
  userId: string
): Promise<McpBridgeTool[]> {
  const servers = await listMcpBridgeServers(db, userId);
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
  options: { signal?: AbortSignal; toolCallId?: string } = {}
): Promise<McpCallResult> {
  const target = await resolveMcpToolExecution(db, userId, name);
  return executeResolvedMcpTool(userId, target, args, options);
}

/** Resolves and authorizes one namespaced tool against its full owned server row. */
export async function resolveMcpToolExecution(
  db: Kysely<Database>,
  userId: string,
  name: string
): Promise<ResolvedMcpToolExecution> {
  const parsed = parseMcpToolName(name);
  if (!parsed) throw new Error(`Unknown tool: "${name}"`);

  const row = await getMcpServerRowBySlug(db, userId, parsed.serverSlug);
  if (!row) throw new Error(`MCP server "${parsed.serverSlug}" is not configured.`);
  if (row.enabled === 0) throw new Error(`MCP server "${parsed.serverSlug}" is disabled.`);

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
