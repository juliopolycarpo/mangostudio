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
import { assertEnvironmentConfig } from '../domain/environment-config';
import {
  type EnvironmentRecord,
  type EnvironmentRepository,
  environmentRepository,
} from '../infrastructure/environment-repository';

export class EnvironmentServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409
  ) {
    super(message);
    this.name = 'EnvironmentServiceError';
  }
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

function toEnvironment(record: EnvironmentRecord, manager: RuntimeConnectionManager): Environment {
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
  };
}

export function createEnvironmentService(
  repository: EnvironmentRepository = environmentRepository,
  manager: RuntimeConnectionManager = getRuntimeConnectionManager(),
  publish: (userId: string) => void = publishEnvironmentInvalidation
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
      return [localRecord(userId), ...rows].map((record) => toEnvironment(record, manager));
    },

    async find(userId, id) {
      const record = await findRecord(userId, id);
      return record ? toEnvironment(record, manager) : null;
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
      const record = await repository.create({
        ...input,
        userId,
        enabled: input.enabled ?? true,
      });
      if (!record) {
        throw new EnvironmentServiceError(`Environment "${input.id}" already exists.`, 409);
      }
      publish(userId);
      return toEnvironment(record, manager);
    },

    async update(userId, id, input) {
      if (id === LOCAL_ENVIRONMENT_ID) {
        throw new EnvironmentServiceError('The Local environment cannot be changed.', 409);
      }
      const current = await requireRecord(userId, id);
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
      const updated = await repository.update(userId, id, input);
      if (!updated) {
        throw new EnvironmentServiceError(`Environment "${id}" was not found.`, 404);
      }
      // A live connection was opened from the definition as it stood before this
      // write. Disabling the environment or repointing its transport must drop
      // it, or the reported status keeps describing the persisted config while
      // every tool call keeps reaching the old endpoint. Dropping it only after
      // the write lands means a rejected update leaves the connection intact.
      if (input.enabled === false || input.config !== undefined) {
        manager.disconnect(userId, id);
      }
      publish(userId);
      return toEnvironment(updated, manager);
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
      return toEnvironment(record, manager);
    },

    async disconnect(userId, id) {
      const record = await requireRecord(userId, id);
      manager.disconnect(userId, id);
      return toEnvironment(record, manager);
    },
  };
}

export const environmentService = createEnvironmentService();
