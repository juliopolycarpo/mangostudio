import { RuntimeRemoteError } from '@mangostudio/runtime';
import type {
  CreateEnvironmentBody,
  Environment,
  UpdateEnvironmentBody,
} from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { publishEnvironmentInvalidation } from '../../../services/realtime/environment-invalidation';
import {
  getRuntimeConnectionManager,
  type RuntimeConnectionManager,
} from '../../../services/runtime-client/runtime-connection-manager';
import {
  hasRuntimeToken,
  persistRuntimeToken,
  removeRuntimeToken,
} from '../../../services/runtime-client/runtime-token-secrets';
import type { SecretStore } from '../../../services/secret-store/store';
import { bunSecretStore } from '../../../services/secret-store/store';
import { assertEnvironmentConfig } from '../domain/environment-config';
import {
  type EnvironmentRecord,
  type EnvironmentRepository,
  environmentRepository,
} from '../infrastructure/environment-repository';

export class EnvironmentServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503
  ) {
    super(message);
    this.name = 'EnvironmentServiceError';
  }
}

function statusForTokenPersistFailure(error: unknown): 400 | 503 {
  // Secret-store outages are server conditions; a malformed request stays 400.
  return error instanceof RuntimeRemoteError && error.code === 'RUNTIME_UNAVAILABLE' ? 503 : 400;
}

export interface EnvironmentService {
  list(userId: string): Promise<Environment[]>;
  find(userId: string, id: string): Promise<Environment | null>;
  create(userId: string, input: CreateEnvironmentBody): Promise<Environment>;
  update(userId: string, id: string, input: UpdateEnvironmentBody): Promise<Environment>;
  remove(userId: string, id: string): Promise<void>;
  connect(userId: string, id: string): Promise<Environment>;
  disconnect(userId: string, id: string): Promise<Environment>;
}

function localRecord(userId: string): EnvironmentRecord {
  return {
    id: LOCAL_ENVIRONMENT_ID,
    userId,
    name: 'Local',
    transportKind: 'in-process',
    config: {},
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

async function toEnvironment(
  record: EnvironmentRecord,
  manager: RuntimeConnectionManager,
  secretStore: SecretStore
): Promise<Environment> {
  return {
    id: record.id,
    name: record.name,
    transportKind: record.transportKind,
    config: record.config,
    enabled: record.enabled,
    virtual: record.id === LOCAL_ENVIRONMENT_ID,
    createdAt: record.id === LOCAL_ENVIRONMENT_ID ? null : record.createdAt,
    updatedAt: record.id === LOCAL_ENVIRONMENT_ID ? null : record.updatedAt,
    status: manager.getStatus(record.userId, record.id),
    ...(record.transportKind === 'http'
      ? { hasRuntimeToken: await hasRuntimeToken(record.userId, record.id, secretStore) }
      : {}),
  };
}

export function createEnvironmentService(
  repository: EnvironmentRepository = environmentRepository,
  manager: RuntimeConnectionManager = getRuntimeConnectionManager(),
  publish: (userId: string) => void = publishEnvironmentInvalidation,
  secretStore: SecretStore = bunSecretStore
): EnvironmentService {
  async function findRecord(userId: string, id: string): Promise<EnvironmentRecord | null> {
    if (id === LOCAL_ENVIRONMENT_ID) return localRecord(userId);
    return await repository.find(userId, id);
  }

  async function requireRecord(userId: string, id: string): Promise<EnvironmentRecord> {
    const record = await findRecord(userId, id);
    if (!record) throw new EnvironmentServiceError(`Environment "${id}" was not found.`, 404);
    return record;
  }

  return {
    async list(userId) {
      const rows = await repository.list(userId);
      return await Promise.all(
        [localRecord(userId), ...rows].map((record) => toEnvironment(record, manager, secretStore))
      );
    },

    async find(userId, id) {
      const record = await findRecord(userId, id);
      return record ? await toEnvironment(record, manager, secretStore) : null;
    },

    async create(userId, input) {
      if (input.id === LOCAL_ENVIRONMENT_ID) {
        throw new EnvironmentServiceError('The Local environment is reserved.', 409);
      }
      try {
        assertEnvironmentConfig(input.transportKind, input.config);
      } catch {
        throw new EnvironmentServiceError(
          `Invalid ${input.transportKind} environment configuration.`,
          400
        );
      }

      const token = input.transportKind === 'http' ? input.token : undefined;
      if (input.transportKind !== 'http' && 'token' in input && input.token !== undefined) {
        throw new EnvironmentServiceError(
          'A runtime token can only be set on a Direct URL (http) environment.',
          400
        );
      }

      const record = await repository.create({
        id: input.id,
        name: input.name,
        transportKind: input.transportKind,
        config: input.config,
        userId,
        enabled: input.enabled ?? true,
      });
      if (!record) {
        throw new EnvironmentServiceError(`Environment "${input.id}" already exists.`, 409);
      }

      if (token) {
        try {
          await persistRuntimeToken(userId, record.id, token, secretStore);
        } catch (error) {
          await repository.remove(userId, record.id);
          throw new EnvironmentServiceError(
            error instanceof Error ? error.message : String(error),
            statusForTokenPersistFailure(error)
          );
        }
      }

      publish(userId);
      return await toEnvironment(record, manager, secretStore);
    },

    async update(userId, id, input) {
      if (id === LOCAL_ENVIRONMENT_ID) {
        throw new EnvironmentServiceError('The Local environment cannot be changed.', 409);
      }
      const current = await requireRecord(userId, id);

      if (input.token !== undefined && current.transportKind !== 'http') {
        throw new EnvironmentServiceError(
          'A runtime token can only be set on a Direct URL (http) environment.',
          400
        );
      }

      if (input.config !== undefined) {
        try {
          assertEnvironmentConfig(current.transportKind, input.config);
        } catch {
          throw new EnvironmentServiceError(
            `Invalid ${current.transportKind} environment configuration.`,
            400
          );
        }
      }

      const { token, ...rowUpdate } = input;
      const updated =
        Object.keys(rowUpdate).length > 0
          ? await repository.update(userId, id, rowUpdate)
          : current;
      if (!updated) {
        throw new EnvironmentServiceError(`Environment "${id}" was not found.`, 404);
      }

      if (token !== undefined) {
        try {
          await persistRuntimeToken(userId, id, token, secretStore);
        } catch (error) {
          // Row fields already moved; put them back so a keychain outage does
          // not leave the environment pointing at a half-applied edit.
          if (Object.keys(rowUpdate).length > 0) {
            await repository.update(userId, id, {
              name: current.name,
              config: current.config,
              enabled: current.enabled,
            });
          }
          throw new EnvironmentServiceError(
            error instanceof Error ? error.message : String(error),
            statusForTokenPersistFailure(error)
          );
        }
      }

      // A live connection was opened from the definition as it stood before this
      // write. Disabling the environment, repointing its transport, or rotating
      // the token must drop it, or the reported status keeps describing the
      // persisted config while every tool call keeps reaching the old endpoint.
      if (input.enabled === false || input.config !== undefined || token !== undefined) {
        manager.disconnect(userId, id);
      } else if (input.enabled === true) {
        // Calls that reached it while it was disabled each recorded a failure,
        // which can already have latched the backoff. Re-enabling is the answer
        // to that, so clear it here rather than making the user press Connect.
        manager.clearBackoff(userId, id);
      }
      publish(userId);
      return await toEnvironment(updated, manager, secretStore);
    },

    async remove(userId, id) {
      if (id === LOCAL_ENVIRONMENT_ID) {
        throw new EnvironmentServiceError('The Local environment cannot be removed.', 409);
      }
      const result = await repository.remove(userId, id);
      if (result === 'referenced') {
        throw new EnvironmentServiceError(
          `Environment "${id}" is still used by one or more chats.`,
          409
        );
      }
      if (result === 'missing') {
        throw new EnvironmentServiceError(`Environment "${id}" was not found.`, 404);
      }
      manager.disconnect(userId, id);
      await removeRuntimeToken(userId, id, secretStore);
      publish(userId);
    },

    async connect(userId, id) {
      await requireRecord(userId, id);
      try {
        // A deliberate connect clears any backoff: the user is telling us the
        // cause was fixed, so waiting out a retry window would be theatre.
        await manager.connect(userId, id, { force: true });
      } catch (error) {
        // The row can be removed between the guard above and the manager's own
        // lookup, which reports it as an unavailable runtime. That is a missing
        // resource, not a connect conflict, so re-read before choosing a status.
        if (!(await findRecord(userId, id))) {
          throw new EnvironmentServiceError(`Environment "${id}" was not found.`, 404);
        }
        throw new EnvironmentServiceError(
          error instanceof Error ? error.message : String(error),
          409
        );
      }
      const record = await requireRecord(userId, id);
      return await toEnvironment(record, manager, secretStore);
    },

    async disconnect(userId, id) {
      const record = await requireRecord(userId, id);
      manager.disconnect(userId, id);
      return await toEnvironment(record, manager, secretStore);
    },
  };
}

export const environmentService = createEnvironmentService();
