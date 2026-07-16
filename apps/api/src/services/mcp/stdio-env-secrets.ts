/**
 * Write-only environment secret persistence for stdio MCP servers. Values
 * live outside the database as one JSON bundle per managed server.
 */

import type { SecretDescriptor, SecretStore } from '../secret-store/store';
import { bunSecretStore } from '../secret-store/store';

function envSecretDescriptor(serverId: string): SecretDescriptor {
  return { service: 'mangostudio', name: `mcp-env:${serverId}` };
}

/** Replaces the stored environment-secret bundle; an empty map removes it. */
export async function persistMcpSecretEnv(
  serverId: string,
  env: Record<string, string>,
  store: SecretStore = bunSecretStore
): Promise<void> {
  if (Object.keys(env).length === 0) {
    await removeMcpSecretEnv(serverId, store);
    return;
  }
  await store.setSecret(envSecretDescriptor(serverId), JSON.stringify(env));
}

/** Missing, malformed, or unavailable bundles resolve to an empty map. */
export async function readMcpSecretEnv(
  serverId: string,
  store: SecretStore = bunSecretStore
): Promise<Record<string, string>> {
  if (!(await store.isAvailable())) return {};
  const raw = await store.getSecret(envSecretDescriptor(serverId));
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === 'string') env[name] = value;
    }
    return env;
  } catch {
    return {};
  }
}

export async function removeMcpSecretEnv(
  serverId: string,
  store: SecretStore = bunSecretStore
): Promise<void> {
  try {
    await store.deleteSecret(envSecretDescriptor(serverId));
  } catch {
    // Already gone or store unavailable — nothing left to protect either way.
  }
}

/** Secret names for public responses; values remain write-only. */
export async function listMcpSecretEnvNames(
  serverId: string,
  store: SecretStore = bunSecretStore
): Promise<string[]> {
  return Object.keys(await readMcpSecretEnv(serverId, store)).sort();
}
