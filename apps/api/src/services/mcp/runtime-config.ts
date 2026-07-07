/**
 * Maps a persisted `mcp_servers` row onto the runtime connection config the
 * connection manager consumes. Shared by the server-management module and the
 * tool bridge so the JSON column parsing lives in one place.
 */

import type { McpServerSelect } from '../../db/types';
import type { McpServerRuntimeConfig } from './types';

export function toMcpRuntimeConfig(row: McpServerSelect): McpServerRuntimeConfig {
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

export function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function parseJsonStringRecord(raw: string): Record<string, string> {
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
