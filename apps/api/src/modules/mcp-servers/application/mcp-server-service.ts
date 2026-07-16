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
import {
  parseJsonStringArray,
  parseJsonStringRecord,
  toMcpRuntimeConfig,
} from '../../../services/mcp/runtime-config';
import {
  listMcpSecretEnvNames,
  persistMcpSecretEnv,
  removeMcpSecretEnv,
} from '../../../services/mcp/stdio-env-secrets';
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
const TEST_MCP_SERVER_TIMEOUT_MS = 10_000;

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
  try {
    if (stdio && body.secretEnv) await persistMcpSecretEnv(id, body.secretEnv);
    if (!stdio && body.headers) await persistMcpHeaders(id, body.headers);
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
  } catch (error) {
    await Promise.all([removeMcpHeaders(id), removeMcpSecretEnv(id)]);
    throw error;
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

  // Each transport owns exactly one secret bundle: headers for http, the child
  // environment for stdio. Persist the bundle the merged transport owns, and
  // drop the other one whenever the body switches transport, so a token never
  // lingers in the secret store unused.
  if (merged.transport === 'http') {
    if (body.headers !== undefined) await persistMcpHeaders(id, body.headers);
    if (body.transport === 'http') await removeMcpSecretEnv(id);
  } else {
    if (body.secretEnv !== undefined) await persistMcpSecretEnv(id, body.secretEnv);
    if (body.transport === 'stdio') await removeMcpHeaders(id);
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
  await Promise.all([removeMcpHeaders(id), removeMcpSecretEnv(id)]);
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
  const config = toMcpRuntimeConfig(row);

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
    const handle = await getMcpClient(userId, toMcpRuntimeConfig(row));
    return { tools: await handle.listTools() };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new McpServerError(detail, 502, ERROR_CODES.PROVIDER_ERROR);
  }
}

export async function requireMcpServerRow(
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
    secretEnvNames: row.transport === 'stdio' ? await listMcpSecretEnvNames(row.id) : [],
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
