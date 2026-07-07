import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  AddMcpServerBody,
  DeleteMcpServerResponse,
  McpServer,
  McpServerListResponse,
  McpServerToolsResponse,
  TestMcpServerResponse,
  UpdateMcpServerBody,
} from '@mangostudio/shared/mcp';
import type { Kysely } from 'kysely';
import type { Database, McpServerSelect } from '../../../db/types';
import {
  disposeMcpServer,
  getMcpClient,
  getMcpRuntimeStatus,
} from '../../../services/mcp/connection-manager';
import {
  listMcpHeaderNames,
  persistMcpHeaders,
  removeMcpHeaders,
} from '../../../services/mcp/header-secrets';
import type { McpServerRuntimeConfig } from '../../../services/mcp/types';
import { generateId } from '../../../utils/id';
import { assertTransportInvariants, McpServerError } from '../domain/mcp-server';
import {
  deleteMcpServerRow,
  getMcpServerRow,
  insertMcpServerRow,
  listMcpServerRows,
  updateMcpServerRow,
} from '../infrastructure/mcp-server-repository';

/** Hard cap on the explicit connection probe (connect + listTools). */
export const TEST_MCP_SERVER_TIMEOUT_MS = 10_000;

export async function listMcpServers(
  db: Kysely<Database>,
  userId: string
): Promise<McpServerListResponse> {
  const rows = await listMcpServerRows(db, userId);
  return { servers: await Promise.all(rows.map((row) => toPublicServer(userId, row))) };
}

export async function createMcpServer(
  db: Kysely<Database>,
  userId: string,
  body: AddMcpServerBody
): Promise<McpServer> {
  const stdio = body.transport === 'stdio';
  const command = stdio ? body.command : null;
  const url = stdio ? null : body.url;
  assertTransportInvariants({ transport: body.transport, command, url });

  const now = Date.now();
  const id = generateId();
  await insertMcpServerRow(db, {
    id,
    userId,
    name: body.name,
    slug: body.slug,
    transport: body.transport,
    command,
    argsJson: JSON.stringify(stdio ? (body.args ?? []) : []),
    envJson: JSON.stringify(stdio ? (body.env ?? {}) : {}),
    url,
    enabled: (body.enabled ?? true) ? 1 : 0,
    timeoutMs: body.timeoutMs ?? null,
    createdAt: now,
    updatedAt: now,
  });

  if (!stdio && body.headers) {
    await persistMcpHeaders(id, body.headers);
  }

  return toPublicServer(userId, await requireMcpServerRow(db, userId, id));
}

export async function updateMcpServer(
  db: Kysely<Database>,
  userId: string,
  id: string,
  body: UpdateMcpServerBody
): Promise<McpServer> {
  const row = await requireMcpServerRow(db, userId, id);

  const merged = {
    transport: body.transport ?? row.transport,
    command: body.command ?? row.command,
    url: body.url ?? row.url,
  };
  assertTransportInvariants(merged);

  await updateMcpServerRow(db, userId, id, {
    ...(body.name !== undefined && { name: body.name }),
    ...(body.slug !== undefined && { slug: body.slug }),
    ...(body.transport !== undefined && { transport: body.transport }),
    ...(body.command !== undefined && { command: body.command }),
    ...(body.args !== undefined && { argsJson: JSON.stringify(body.args) }),
    ...(body.env !== undefined && { envJson: JSON.stringify(body.env) }),
    ...(body.url !== undefined && { url: body.url }),
    ...(body.enabled !== undefined && { enabled: body.enabled ? 1 : 0 }),
    ...(body.timeoutMs !== undefined && { timeoutMs: body.timeoutMs }),
    updatedAt: Date.now(),
  });

  if (body.headers !== undefined) {
    await persistMcpHeaders(id, body.headers);
  }

  // The old session runs with stale config; drop it so next use reconnects.
  await disposeMcpServer(userId, id);

  return toPublicServer(userId, await requireMcpServerRow(db, userId, id));
}

export async function removeMcpServer(
  db: Kysely<Database>,
  userId: string,
  id: string
): Promise<DeleteMcpServerResponse> {
  await requireMcpServerRow(db, userId, id);
  await deleteMcpServerRow(db, userId, id);
  await removeMcpHeaders(id);
  await disposeMcpServer(userId, id);
  return { ok: true };
}

/**
 * Explicit connection probe: connect and list tools under a hard cap. Failures
 * come back in the response body — an unreachable server is a result here,
 * not an exception.
 */
export async function testMcpServer(
  db: Kysely<Database>,
  userId: string,
  id: string
): Promise<TestMcpServerResponse> {
  const row = await requireMcpServerRow(db, userId, id);
  const config = toRuntimeConfig(row);

  try {
    const tools = await withHardTimeout(
      (async () => {
        const handle = await getMcpClient(userId, config);
        return handle.listTools({ timeoutMs: TEST_MCP_SERVER_TIMEOUT_MS });
      })(),
      TEST_MCP_SERVER_TIMEOUT_MS
    );
    return { ok: true, status: 'connected', tools };
  } catch (error) {
    // Never leave a half-open or still-connecting session behind a failed probe.
    await disposeMcpServer(userId, id);
    return {
      ok: false,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listMcpServerTools(
  db: Kysely<Database>,
  userId: string,
  id: string
): Promise<McpServerToolsResponse> {
  const row = await requireMcpServerRow(db, userId, id);

  try {
    const handle = await getMcpClient(userId, toRuntimeConfig(row));
    return { tools: await handle.listTools() };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new McpServerError(detail, 502, ERROR_CODES.PROVIDER_ERROR);
  }
}

async function requireMcpServerRow(
  db: Kysely<Database>,
  userId: string,
  id: string
): Promise<McpServerSelect> {
  const row = await getMcpServerRow(db, userId, id);
  if (!row) {
    throw new McpServerError('MCP server not found.', 404, ERROR_CODES.NOT_FOUND);
  }
  return row;
}

function toRuntimeConfig(row: McpServerSelect): McpServerRuntimeConfig {
  return {
    id: row.id,
    slug: row.slug,
    transport: row.transport,
    command: row.command,
    args: parseJsonStringArray(row.argsJson),
    env: parseJsonStringRecord(row.envJson),
    url: row.url,
    timeoutMs: row.timeoutMs,
  };
}

async function toPublicServer(userId: string, row: McpServerSelect): Promise<McpServer> {
  const runtime = getMcpRuntimeStatus(userId, row.id);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    transport: row.transport,
    command: row.command,
    args: parseJsonStringArray(row.argsJson),
    env: parseJsonStringRecord(row.envJson),
    url: row.url,
    headerNames: row.transport === 'http' ? await listMcpHeaderNames(row.id) : [],
    enabled: row.enabled !== 0,
    timeoutMs: row.timeoutMs,
    status: runtime.status,
    ...(runtime.error !== undefined && { statusError: runtime.error }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonStringRecord(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') record[key] = value;
    }
    return record;
  } catch {
    return {};
  }
}

async function withHardTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`MCP server did not respond within ${ms / 1000}s.`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
