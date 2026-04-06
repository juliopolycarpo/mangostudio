import {
  SecretStorageUnavailableError,
  type SecretDescriptor,
  type SecretStore,
} from '../../../src/services/secret-store';

/**
 * In-memory SecretStore implementation for tests.
 */
export class InMemorySecretStore implements SecretStore {
  available = true;
  store = new Map<string, string>();

  private getKey(secret: SecretDescriptor): string {
    return `${secret.service}:${secret.name}`;
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available);
  }

  getSecret(secret: SecretDescriptor): Promise<string | null> {
    if (!this.available) {
      return Promise.reject(new SecretStorageUnavailableError('unavailable'));
    }

    return Promise.resolve(this.store.get(this.getKey(secret)) ?? null);
  }

  setSecret(secret: SecretDescriptor, value: string): Promise<void> {
    if (!this.available) {
      return Promise.reject(new SecretStorageUnavailableError('unavailable'));
    }

    this.store.set(this.getKey(secret), value);
    return Promise.resolve();
  }

  deleteSecret(secret: SecretDescriptor): Promise<boolean> {
    if (!this.available) {
      return Promise.reject(new SecretStorageUnavailableError('unavailable'));
    }

    return Promise.resolve(this.store.delete(this.getKey(secret)));
  }
}

/**
 * Creates an in-memory secret store preloaded with test secrets.
 *
 * @param initialSecrets - Optional secrets to seed into the store.
 * @returns A seeded in-memory secret store.
 */
export function createMockSecretStore(
  initialSecrets?: Array<{ secret: SecretDescriptor; value: string }>
) {
  const store = new InMemorySecretStore();

  if (initialSecrets) {
    for (const { secret, value } of initialSecrets) {
      store.store.set(`${secret.service}:${secret.name}`, value);
    }
  }

  return store;
}
