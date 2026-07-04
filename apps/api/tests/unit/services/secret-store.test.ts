import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigForTest } from '../../../src/lib/config';
import {
  createBunSecretStore,
  type SecretDescriptor,
  SecretStorageUnavailableError,
} from '../../../src/services/secret-store/store';

type SecretRecord = SecretDescriptor & { value?: string };

function createMockSecretsApi(initial: SecretRecord[] = []) {
  const store = new Map<string, string>();
  for (const record of initial) {
    store.set(`${record.service}:${record.name}`, record.value ?? '');
  }

  return {
    store,
    get: (secret: SecretDescriptor): Promise<string | null> =>
      Promise.resolve(store.get(`${secret.service}:${secret.name}`) ?? null),
    set: (secret: SecretDescriptor & { value: string }): Promise<void> => {
      store.set(`${secret.service}:${secret.name}`, secret.value);
      return Promise.resolve();
    },
    delete: (secret: SecretDescriptor): Promise<boolean> =>
      Promise.resolve(store.delete(`${secret.service}:${secret.name}`)),
  };
}

/**
 * Windows Credential Manager caps generic credential blobs at
 * CRED_MAX_CREDENTIAL_BLOB_SIZE (2560 bytes); CredWrite rejects larger blobs
 * with RPC_X_BAD_STUB_DATA. Mirrors Bun's Windows backend, which passes the
 * UTF-8 bytes of the value straight through to CredWriteW.
 */
const WINDOWS_CRED_BLOB_LIMIT_BYTES = 2560;

function createWindowsLimitedSecretsApi(initial: SecretRecord[] = []) {
  const api = createMockSecretsApi(initial);
  return {
    ...api,
    set: (secret: SecretDescriptor & { value: string }): Promise<void> => {
      if (Buffer.byteLength(secret.value, 'utf8') > WINDOWS_CRED_BLOB_LIMIT_BYTES) {
        return Promise.reject(new Error('The stub received bad data. (code: 1783)'));
      }
      return api.set(secret);
    },
  };
}

describe('createBunSecretStore', () => {
  it('reports available when the secrets API responds', async () => {
    const api = createMockSecretsApi();
    const store = createBunSecretStore(api);

    expect(await store.isAvailable()).toBe(true);
  });

  it('reports unavailable when the secrets API throws', async () => {
    const api = {
      get: (): Promise<string | null> => Promise.reject(new Error('keychain locked')),
      set: (): Promise<void> => Promise.resolve(),
      delete: (): Promise<boolean> => Promise.resolve(false),
    };
    const store = createBunSecretStore(api);

    expect(await store.isAvailable()).toBe(false);
  });

  it('throws SecretStorageUnavailableError with the underlying message', async () => {
    const api = {
      get: (): Promise<string | null> => Promise.reject(new Error('no keychain')),
      set: (): Promise<void> => Promise.resolve(),
      delete: (): Promise<boolean> => Promise.resolve(false),
    };
    const store = createBunSecretStore(api);

    try {
      await store.getSecret({ service: 'test', name: 'key' });
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(SecretStorageUnavailableError);
      expect((err as Error).message).toBe('no keychain');
    }
  });

  it('throws SecretStorageUnavailableError for non-Error rejects', async () => {
    const api = {
      get: (): Promise<string | null> => Promise.reject(new Error('unknown')),
      set: (): Promise<void> => Promise.resolve(),
      delete: (): Promise<boolean> => Promise.resolve(false),
    };

    // Force a non-Error rejection through the probe by replacing get temporarily
    const originalGet = api.get;
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    api.get = () => Promise.reject('plain string rejection');

    const store = createBunSecretStore(api);

    try {
      await store.setSecret({ service: 'test', name: 'key' }, 'value');
      expect(false).toBe(true);
    } catch (err) {
      expect(err).toBeInstanceOf(SecretStorageUnavailableError);
      expect((err as Error).message).toBe('Unknown secret storage error');
    } finally {
      api.get = originalGet;
    }
  });

  it('reads a stored secret', async () => {
    const api = createMockSecretsApi([{ service: 'svc', name: 'api-key', value: 'secret123' }]);
    const store = createBunSecretStore(api);

    const value = await store.getSecret({ service: 'svc', name: 'api-key' });
    expect(value).toBe('secret123');
  });

  it('returns null for a missing secret', async () => {
    const api = createMockSecretsApi();
    const store = createBunSecretStore(api);

    const value = await store.getSecret({ service: 'svc', name: 'missing' });
    expect(value).toBeNull();
  });

  it('persists a secret', async () => {
    const api = createMockSecretsApi();
    const store = createBunSecretStore(api);

    await store.setSecret({ service: 'svc', name: 'api-key' }, 'new-value');
    const value = await store.getSecret({ service: 'svc', name: 'api-key' });
    expect(value).toBe('new-value');
  });

  it('deletes a secret and returns true when it existed', async () => {
    const api = createMockSecretsApi([{ service: 'svc', name: 'old-key', value: 'x' }]);
    const store = createBunSecretStore(api);

    const deleted = await store.deleteSecret({ service: 'svc', name: 'old-key' });
    expect(deleted).toBe(true);
    expect(await store.getSecret({ service: 'svc', name: 'old-key' })).toBeNull();
  });

  it('returns false when deleting a missing secret', async () => {
    const api = createMockSecretsApi();
    const store = createBunSecretStore(api);

    const deleted = await store.deleteSecret({ service: 'svc', name: 'missing' });
    expect(deleted).toBe(false);
  });

  describe('values above the Windows credential blob limit', () => {
    // Shaped like a persisted ChatGPT OAuth bundle: three JWT-sized tokens plus
    // a non-ASCII display name to exercise UTF-8 byte handling.
    const largeBundle = JSON.stringify({
      accessToken: 'a'.repeat(4000),
      idToken: 'i'.repeat(2000),
      refreshToken: 'r'.repeat(200),
      email: 'júlio@example.com',
    });
    const descriptor = { service: 'mangostudio', name: 'chatgpt-api-key:conn-1' };

    it('round-trips a token bundle through a Windows-limited backend (regression: error 1783)', async () => {
      const api = createWindowsLimitedSecretsApi();
      const store = createBunSecretStore(api);

      await store.setSecret(descriptor, largeBundle);
      expect(await store.getSecret(descriptor)).toBe(largeBundle);

      for (const value of api.store.values()) {
        expect(Buffer.byteLength(value, 'utf8')).toBeLessThanOrEqual(WINDOWS_CRED_BLOB_LIMIT_BYTES);
      }
    });

    it('keeps small values in the legacy plain layout', async () => {
      const api = createWindowsLimitedSecretsApi();
      const store = createBunSecretStore(api);

      await store.setSecret({ service: 'svc', name: 'api-key' }, 'sk-plain');
      expect(api.store.get('svc:api-key')).toBe('sk-plain');
      expect(api.store.size).toBe(1);
    });

    it('reads a legacy plain value that exceeds the chunking threshold', async () => {
      // Written by a pre-chunking build on macOS/Linux, where large blobs work.
      const legacyValue = 'x'.repeat(5000);
      const api = createMockSecretsApi([
        { service: 'svc', name: 'legacy-bundle', value: legacyValue },
      ]);
      const store = createBunSecretStore(api);

      expect(await store.getSecret({ service: 'svc', name: 'legacy-bundle' })).toBe(legacyValue);
    });

    it('removes stale chunks when overwriting with a small value', async () => {
      const api = createWindowsLimitedSecretsApi();
      const store = createBunSecretStore(api);

      await store.setSecret(descriptor, largeBundle);
      await store.setSecret(descriptor, 'small-replacement');

      expect(await store.getSecret(descriptor)).toBe('small-replacement');
      expect(api.store.size).toBe(1);
    });

    it('removes leftover chunks when a chunked value shrinks', async () => {
      const api = createWindowsLimitedSecretsApi();
      const store = createBunSecretStore(api);

      await store.setSecret(descriptor, 'z'.repeat(20_000));
      const entriesWhenLarge = api.store.size;
      await store.setSecret(descriptor, largeBundle);

      expect(api.store.size).toBeLessThan(entriesWhenLarge);
      expect(await store.getSecret(descriptor)).toBe(largeBundle);
    });

    it('deletes every chunk entry along with the secret', async () => {
      const api = createWindowsLimitedSecretsApi();
      const store = createBunSecretStore(api);

      await store.setSecret(descriptor, largeBundle);
      expect(await store.deleteSecret(descriptor)).toBe(true);
      expect(api.store.size).toBe(0);
      expect(await store.getSecret(descriptor)).toBeNull();
    });

    it('treats a marker with missing chunks as a missing secret', async () => {
      const api = createMockSecretsApi([
        { service: 'svc', name: 'torn', value: '__mango-chunks-v1__:2' },
        { service: 'svc', name: 'torn#0', value: 'YWJj' },
      ]);
      const store = createBunSecretStore(api);

      expect(await store.getSecret({ service: 'svc', name: 'torn' })).toBeNull();
    });
  });

  it('uses the configured unsafe file store when native secrets are unavailable', async () => {
    const fallbackDir = mkdtempSync(join(tmpdir(), 'mango-secret-fallback-'));
    loadConfigForTest({
      secretStore: { unsafeFileFallbackDir: fallbackDir },
    });
    const api = {
      get: (): Promise<string | null> => Promise.reject(new Error('libsecret not available')),
      set: (): Promise<void> => Promise.reject(new Error('libsecret not available')),
      delete: (): Promise<boolean> => Promise.reject(new Error('libsecret not available')),
    };
    const store = createBunSecretStore(api);

    try {
      expect(await store.isAvailable()).toBe(true);
      await store.setSecret({ service: 'svc', name: 'api-key' }, 'fallback-secret');
      expect(await store.getSecret({ service: 'svc', name: 'api-key' })).toBe('fallback-secret');
      expect(await store.deleteSecret({ service: 'svc', name: 'api-key' })).toBe(true);
      expect(await store.getSecret({ service: 'svc', name: 'api-key' })).toBeNull();
    } finally {
      loadConfigForTest({ secretStore: { unsafeFileFallbackDir: '' } });
      rmSync(fallbackDir, { recursive: true, force: true });
    }
  });

  it('prefers the configured unsafe file store over native secrets', async () => {
    const fallbackDir = mkdtempSync(join(tmpdir(), 'mango-secret-fallback-'));
    loadConfigForTest({
      secretStore: { unsafeFileFallbackDir: fallbackDir },
    });
    let nativeCalls = 0;
    const api = {
      get: (): Promise<string | null> => {
        nativeCalls += 1;
        return Promise.resolve('native-secret');
      },
      set: (): Promise<void> => {
        nativeCalls += 1;
        return Promise.resolve();
      },
      delete: (): Promise<boolean> => {
        nativeCalls += 1;
        return Promise.resolve(true);
      },
    };
    const store = createBunSecretStore(api);

    try {
      expect(await store.isAvailable()).toBe(true);
      await store.setSecret({ service: 'svc', name: 'api-key' }, 'file-secret');
      expect(await store.getSecret({ service: 'svc', name: 'api-key' })).toBe('file-secret');
      expect(nativeCalls).toBe(0);
    } finally {
      loadConfigForTest({ secretStore: { unsafeFileFallbackDir: '' } });
      rmSync(fallbackDir, { recursive: true, force: true });
    }
  });
});
