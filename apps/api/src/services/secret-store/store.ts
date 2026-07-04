/**
 * Thin Bun.secrets wrapper used by provider-specific secret services.
 *
 * Windows Credential Manager caps generic credential blobs at
 * CRED_MAX_CREDENTIAL_BLOB_SIZE (2560 bytes); larger CredWrite calls fail with
 * RPC_X_BAD_STUB_DATA ("The stub received bad data.", code 1783). OAuth token
 * bundles blow past that, so values above MAX_NATIVE_VALUE_BYTES are stored as
 * base64 slices under `<name>#<index>` entries with a small marker as the main
 * entry. Values at or below the limit keep the legacy plain layout.
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

/**
 * Keeps every native entry safely under the 2560-byte Windows credential blob
 * limit; base64 chunk slices are ASCII, so chars == stored bytes.
 */
const MAX_NATIVE_VALUE_BYTES = 2048;
const CHUNK_MARKER_PREFIX = '__mango-chunks-v1__:';
/** Sanity bound when parsing a marker (~768KB payload), not a design limit. */
const MAX_CHUNK_COUNT = 512;

function chunkEntryName(name: string, index: number): string {
  return `${name}#${index}`;
}

/** Chunk count from a marker entry, or null when the value is a plain secret. */
function parseChunkCount(value: string): number | null {
  if (!value.startsWith(CHUNK_MARKER_PREFIX)) return null;
  const count = Number(value.slice(CHUNK_MARKER_PREFIX.length));
  if (!Number.isInteger(count) || count < 1 || count > MAX_CHUNK_COUNT) return null;
  return count;
}

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

  const readChunkCount = async (secret: SecretDescriptor): Promise<number> => {
    const value = await secretsApi.get(secret);
    return value === null ? 0 : (parseChunkCount(value) ?? 0);
  };

  const deleteChunks = async (secret: SecretDescriptor, from: number, to: number) => {
    for (let index = from; index < to; index += 1) {
      await secretsApi.delete({
        service: secret.service,
        name: chunkEntryName(secret.name, index),
      });
    }
  };

  const readNative = async (secret: SecretDescriptor): Promise<string | null> => {
    const value = await secretsApi.get(secret);
    if (value === null) return null;
    const chunkCount = parseChunkCount(value);
    if (chunkCount === null) return value;

    const chunks: string[] = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = await secretsApi.get({
        service: secret.service,
        name: chunkEntryName(secret.name, index),
      });
      // A marker without all of its chunks is a torn write; report the secret
      // as missing so callers fall back to re-configuration.
      if (chunk === null) return null;
      chunks.push(chunk);
    }
    return Buffer.from(chunks.join(''), 'base64').toString('utf8');
  };

  const writeNative = async (secret: SecretDescriptor, value: string): Promise<void> => {
    const previousChunkCount = await readChunkCount(secret);

    if (Buffer.byteLength(value, 'utf8') <= MAX_NATIVE_VALUE_BYTES) {
      await secretsApi.set({ ...secret, value });
      await deleteChunks(secret, 0, previousChunkCount);
      return;
    }

    const encoded = Buffer.from(value, 'utf8').toString('base64');
    const chunkCount = Math.ceil(encoded.length / MAX_NATIVE_VALUE_BYTES);
    for (let index = 0; index < chunkCount; index += 1) {
      await secretsApi.set({
        service: secret.service,
        name: chunkEntryName(secret.name, index),
        value: encoded.slice(index * MAX_NATIVE_VALUE_BYTES, (index + 1) * MAX_NATIVE_VALUE_BYTES),
      });
    }
    // Chunks land before the marker so a crash mid-write leaves the previous
    // main entry intact instead of a marker pointing at missing chunks.
    await secretsApi.set({ ...secret, value: `${CHUNK_MARKER_PREFIX}${chunkCount}` });
    await deleteChunks(secret, chunkCount, previousChunkCount);
  };

  const deleteNative = async (secret: SecretDescriptor): Promise<boolean> => {
    const previousChunkCount = await readChunkCount(secret);
    const deleted = await secretsApi.delete(secret);
    await deleteChunks(secret, 0, previousChunkCount);
    return deleted;
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
      return readNative(secret);
    },
    async setSecret(secret, value) {
      if ((await resolveBackend()) === 'file') {
        writeFileSecret(secret, value);
        return;
      }
      await writeNative(secret, value);
    },
    async deleteSecret(secret) {
      if ((await resolveBackend()) === 'file') {
        return deleteFileSecret(secret);
      }
      return deleteNative(secret);
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
