/**
 * Thin Bun.secrets wrapper used by provider-specific secret services.
 */

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

/** Error thrown when the OS-native secret store is unavailable. */
export class SecretStorageUnavailableError extends Error {
  constructor(message: string = 'OS secret storage is unavailable') {
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
  const readAvailabilityProbe = async (): Promise<void> => {
    try {
      await secretsApi.get({
        service: 'mangostudio',
        name: '__availability_probe__',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown secret storage error';
      throw new SecretStorageUnavailableError(message);
    }
  };

  return {
    async isAvailable() {
      try {
        await readAvailabilityProbe();
        return true;
      } catch {
        return false;
      }
    },
    async getSecret(secret) {
      await readAvailabilityProbe();
      return secretsApi.get(secret);
    },
    async setSecret(secret, value) {
      await readAvailabilityProbe();
      await secretsApi.set({
        ...secret,
        value,
      });
    },
    async deleteSecret(secret) {
      await readAvailabilityProbe();
      return secretsApi.delete(secret);
    },
  };
}

/** Shared application store for OS-managed secrets. */
export const bunSecretStore = createBunSecretStore();
