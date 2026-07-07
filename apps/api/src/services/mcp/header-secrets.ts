/**
 * Auth header persistence for HTTP MCP servers. Headers are stored as one
 * JSON map per server under `mcp-headers:<serverId>` in the OS secret store,
 * so header values never touch a database row; responses may expose the
 * header names only.
 */

import type { SecretDescriptor, SecretStore } from '../secret-store/store';
import { bunSecretStore } from '../secret-store/store';

function headerSecretDescriptor(serverId: string): SecretDescriptor {
  return { service: 'mangostudio', name: `mcp-headers:${serverId}` };
}

/** Replaces the stored header bundle; an empty map removes it entirely. */
export async function persistMcpHeaders(
  serverId: string,
  headers: Record<string, string>,
  store: SecretStore = bunSecretStore
): Promise<void> {
  if (Object.keys(headers).length === 0) {
    await removeMcpHeaders(serverId, store);
    return;
  }
  await store.setSecret(headerSecretDescriptor(serverId), JSON.stringify(headers));
}

/** Reads the header bundle; missing or malformed bundles resolve to `{}`. */
export async function readMcpHeaders(
  serverId: string,
  store: SecretStore = bunSecretStore
): Promise<Record<string, string>> {
  const raw = await store.getSecret(headerSecretDescriptor(serverId));
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === 'string') headers[name] = value;
    }
    return headers;
  } catch {
    return {};
  }
}

export async function removeMcpHeaders(
  serverId: string,
  store: SecretStore = bunSecretStore
): Promise<void> {
  try {
    await store.deleteSecret(headerSecretDescriptor(serverId));
  } catch {
    // Already gone or store unavailable — nothing left to protect either way.
  }
}

/** Header names for API responses; values stay in the store. */
export async function listMcpHeaderNames(
  serverId: string,
  store: SecretStore = bunSecretStore
): Promise<string[]> {
  return Object.keys(await readMcpHeaders(serverId, store));
}
