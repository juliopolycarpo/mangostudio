/**
 * Thin Bun.secrets wrapper used by provider-specific secret services.
 */

import { join } from 'node:path';
import { getConfig } from '../../lib/config';
import { readUtf8FileOrNull, SECRET_FILE_MODE, writeFileAtomic } from '../../lib/safe-file';

export interface SecretDescriptor {
  service: string;
  name: string;
}

export interface SecretStore {
  isAvailable(): Promise<boolean>;
  getSecret(secret: SecretDescriptor): Promise<string | null>;
  setSecret(secret: SecretDescriptor, value: string): Promise<void>;
  deleteSecret(secret: SecretDescriptor): Promise<boolean>;
}

type BunSecretsApi = Pick<typeof Bun.secrets, 'get' | 'set' | 'delete'>;
type SecretBackend = 'native' | 'file';

/** Error thrown when the OS-native secret store is unavailable. */
export class SecretStorageUnavailableError extends Error {
  constructor(message = 'OS secret storage is unavailable') {
    super(message);
    this.name = 'SecretStorageUnavailableError';
  }
}

/**
 * Creates a Bun-backed secret store.
 *
 * @param secretsApi - Bun secrets API implementation to use.
 * @returns A typed secret store wrapper.
 */
export function createBunSecretStore(secretsApi: BunSecretsApi = Bun.secrets): SecretStore {
  const resolveBackend = async (): Promise<SecretBackend> => {
    if (resolveUnsafeFallbackPath()) return 'file';

    try {
      await secretsApi.get({
        service: 'mangostudio',
        name: '__availability_probe__',
      });
      return 'native';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown secret storage error';
      throw new SecretStorageUnavailableError(message);
    }
  };

  return {
    async isAvailable() {
      try {
        await resolveBackend();
        return true;
      } catch {
        return false;
      }
    },
    async getSecret(secret) {
      if ((await resolveBackend()) === 'file') {
        return readFileSecret(secret);
      }
      return secretsApi.get(secret);
    },
    async setSecret(secret, value) {
      if ((await resolveBackend()) === 'file') {
        writeFileSecret(secret, value);
        return;
      }
      await secretsApi.set({
        ...secret,
        value,
      });
    },
    async deleteSecret(secret) {
      if ((await resolveBackend()) === 'file') {
        return deleteFileSecret(secret);
      }
      return secretsApi.delete(secret);
    },
  };
}

/** Shared application store for OS-managed secrets. */
export const bunSecretStore = createBunSecretStore();

function resolveUnsafeFallbackPath(): string | null {
  const dir = getConfig().secretStore.unsafeFileFallbackDir.trim();
  return dir ? join(dir, 'secrets.json') : null;
}

function secretKey(secret: SecretDescriptor): string {
  return `${secret.service}:${secret.name}`;
}

function readFileStore(): Record<string, string> {
  const filePath = resolveUnsafeFallbackPath();
  if (!filePath) return {};
  const raw = readUtf8FileOrNull(filePath);
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    const records: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') records[key] = value;
    }
    return records;
  } catch {
    throw new SecretStorageUnavailableError('Unsafe file secret store is malformed.');
  }
}

function writeFileStore(records: Record<string, string>): void {
  const filePath = resolveUnsafeFallbackPath();
  if (!filePath) throw new SecretStorageUnavailableError('Unsafe file secret store is disabled.');
  writeFileAtomic(filePath, `${JSON.stringify(records, null, 2)}\n`, { mode: SECRET_FILE_MODE });
}

function readFileSecret(secret: SecretDescriptor): string | null {
  return readFileStore()[secretKey(secret)] ?? null;
}

function writeFileSecret(secret: SecretDescriptor, value: string): void {
  writeFileStore({ ...readFileStore(), [secretKey(secret)]: value });
}

function deleteFileSecret(secret: SecretDescriptor): boolean {
  const records = readFileStore();
  const key = secretKey(secret);
  if (!(key in records)) return false;
  delete records[key];
  writeFileStore(records);
  return true;
}
