import { describe, expect, it } from 'bun:test';
import {
  createBunSecretStore,
  SecretStorageUnavailableError,
  type SecretDescriptor,
} from '../../../src/services/secret-store/store';

type SecretRecord = SecretDescriptor & { value?: string };

function createMockSecretsApi(initial: SecretRecord[] = []) {
  const store = new Map<string, string>();
  for (const record of initial) {
    store.set(`${record.service}:${record.name}`, record.value ?? '');
  }

  return {
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
});
