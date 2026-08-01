/**
 * Auth token persistence for Direct URL (`http`) runtimes. One secret per
 * environment under `runtime-token:<userId>:<environmentId>` in the OS secret
 * store — never in a database row. Environment ids are only unique per user, so
 * the key must include both. Unlike MCP headers, an unavailable store is a hard
 * failure: without a token the hub cannot dial, so soft-failing to empty would
 * only hide a misconfigured machine.
 */

import { RuntimeRemoteError } from '@mangostudio/runtime';
import { createDiagnosticLogger } from '../../lib/logger';
import type { SecretDescriptor, SecretStore } from '../secret-store/store';
import { bunSecretStore, SecretStorageUnavailableError } from '../secret-store/store';

const logger = createDiagnosticLogger('runtime-token');

function runtimeTokenDescriptor(userId: string, environmentId: string): SecretDescriptor {
  return { service: 'mangostudio', name: `runtime-token:${userId}:${environmentId}` };
}

let storeForTests: SecretStore | undefined;

/** Test-only override so dial-out uses the same in-memory store the service wrote. */
export function setRuntimeTokenStoreForTests(store: SecretStore | undefined): void {
  storeForTests = store;
}

function resolveStore(store?: SecretStore): SecretStore {
  return store ?? storeForTests ?? bunSecretStore;
}

function unavailableStore(cause: unknown): RuntimeRemoteError {
  const detail =
    cause instanceof Error && cause.message.trim().length > 0
      ? cause.message
      : 'OS secret storage (keychain / credential manager) is unavailable.';
  return new RuntimeRemoteError(
    'RUNTIME_UNAVAILABLE',
    `The runtime token could not be read from the secret store: ${detail}`
  );
}

function missingToken(environmentId: string): RuntimeRemoteError {
  return new RuntimeRemoteError(
    'RUNTIME_UNAVAILABLE',
    `No runtime token is configured for environment "${environmentId}". Set one on the environment card.`
  );
}

async function requireAvailable(store: SecretStore): Promise<void> {
  if (await store.isAvailable()) return;
  throw unavailableStore(new SecretStorageUnavailableError());
}

/** Replaces the stored Direct URL token for this environment. */
export async function persistRuntimeToken(
  userId: string,
  environmentId: string,
  token: string,
  store: SecretStore = resolveStore()
): Promise<void> {
  await requireAvailable(store);
  try {
    await store.setSecret(runtimeTokenDescriptor(userId, environmentId), token);
  } catch (error) {
    if (error instanceof SecretStorageUnavailableError) throw unavailableStore(error);
    throw error;
  }
}

/**
 * Reads the Direct URL token. Hard-fails when the secret store is unavailable
 * or when no token has been configured.
 */
export async function readRuntimeToken(
  userId: string,
  environmentId: string,
  store: SecretStore = resolveStore()
): Promise<string> {
  await requireAvailable(store);
  let raw: string | null;
  try {
    raw = await store.getSecret(runtimeTokenDescriptor(userId, environmentId));
  } catch (error) {
    if (error instanceof SecretStorageUnavailableError) throw unavailableStore(error);
    throw error;
  }
  if (!raw || raw.trim().length === 0) throw missingToken(environmentId);
  return raw;
}

export async function removeRuntimeToken(
  userId: string,
  environmentId: string,
  store: SecretStore = resolveStore()
): Promise<void> {
  try {
    await store.deleteSecret(runtimeTokenDescriptor(userId, environmentId));
  } catch (error) {
    // Already gone or store unavailable — nothing left to protect either way,
    // but operators need a signal when cleanup did not happen.
    logger.warn('runtime_token_remove_failed', {
      userId,
      environmentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function hasRuntimeToken(
  userId: string,
  environmentId: string,
  store: SecretStore = resolveStore()
): Promise<boolean> {
  if (!(await store.isAvailable())) return false;
  try {
    const raw = await store.getSecret(runtimeTokenDescriptor(userId, environmentId));
    return typeof raw === 'string' && raw.trim().length > 0;
  } catch {
    return false;
  }
}
