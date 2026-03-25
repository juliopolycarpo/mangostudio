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

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async getSecret(secret: SecretDescriptor): Promise<string | null> {
    if (!this.available) {
      throw new SecretStorageUnavailableError('unavailable');
    }

    return this.store.get(this.getKey(secret)) ?? null;
  }

  async setSecret(secret: SecretDescriptor, value: string): Promise<void> {
    if (!this.available) {
      throw new SecretStorageUnavailableError('unavailable');
    }

    this.store.set(this.getKey(secret), value);
  }

  async deleteSecret(secret: SecretDescriptor): Promise<boolean> {
    if (!this.available) {
      throw new SecretStorageUnavailableError('unavailable');
    }

    return this.store.delete(this.getKey(secret));
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
