import { RemoteError, RESERVED_ERROR_CODES } from '@mangostudio/protocol';
import type {
  CreateEnvironmentBody,
  Environment,
  ToolchainSelection,
  UpdateEnvironmentBody,
} from '@mangostudio/shared/environments';
import {
  DEFAULT_TOOLCHAIN_SELECTION,
  LOCAL_ENVIRONMENT_ID,
  LOCAL_ENVIRONMENT_NAME,
  type SshEnvironmentConfig,
} from '@mangostudio/shared/environments';

import { acquireToolchainCredentialLock } from '../../../backup/capture-lock';
import { getConfig } from '../../../lib/config';
import { isEnvironmentUnavailable } from '../../../lib/environment-unavailable';
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
import { assertEnvironmentConfig, environmentConfigFor } from '../domain/environment-config';
import { diagnosticOf, EnvironmentServiceError } from '../domain/environment-error';
import { type RuntimeCommandRunner, runtimeRemoveSlotBytesScript } from '../domain/runtime-push';
import {
  type EnvironmentRecord,
  type EnvironmentRepository,
  environmentRepository,
} from '../infrastructure/environment-repository';
import { createSshCommandRunner } from '../infrastructure/ssh-command-runner';
import { wslProvisioner } from '../infrastructure/wsl-provisioner';
import { runtimeLifecycleService } from './runtime-lifecycle-service';
import { type ToolchainService, toolchainService } from './toolchain-service';

function statusForTokenPersistFailure(error: unknown): 400 | 503 {
  // Secret-store outages are server conditions; a malformed request stays 400.
  return error instanceof RemoteError && error.code === RESERVED_ERROR_CODES.UNAVAILABLE
    ? 503
    : 400;
}

export interface EnvironmentService {
  list(userId: string): Promise<Environment[]>;
  find(userId: string, id: string): Promise<Environment | null>;
  create(userId: string, input: CreateEnvironmentBody): Promise<Environment>;
  update(userId: string, id: string, input: UpdateEnvironmentBody): Promise<Environment>;
  remove(userId: string, id: string, options?: { readonly removeRuntime?: boolean }): Promise<void>;
  connect(userId: string, id: string): Promise<Environment>;
  disconnect(userId: string, id: string): Promise<Environment>;
}

function localRecord(userId: string): EnvironmentRecord {
  return {
    id: LOCAL_ENVIRONMENT_ID,
    userId,
    name: LOCAL_ENVIRONMENT_NAME,
    transportKind: 'in-process',
    config: {},
    enabled: true,
    // The hub's own machine is governed by the loopback guard rather than by
    // this flag, and always has been. It is reported as trusted so the card
    // does not offer a toggle that would decide nothing.
    allowInstalls: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

async function toEnvironment(
  record: EnvironmentRecord,
  manager: RuntimeConnectionManager,
  secretStore: SecretStore,
  toolchain: ToolchainService,
  selection?: ToolchainSelection
): Promise<Environment> {
  // Consent is answered on the machine, so nothing here can invalidate the
  // manifest cached at connect. Reading an environment is the moment someone
  // is looking at what the machine permits, which makes it the moment worth
  // re-asking: this returns immediately and publishes only if the answer moved.
  manager.refreshManifestIfStale(record.userId, record.id);

  return {
    id: record.id,
    name: record.name,
    transportKind: record.transportKind,
    config: record.config,
    enabled: record.enabled,
    allowInstalls: record.allowInstalls,
    virtual: record.id === LOCAL_ENVIRONMENT_ID,
    createdAt: record.id === LOCAL_ENVIRONMENT_ID ? null : record.createdAt,
    updatedAt: record.id === LOCAL_ENVIRONMENT_ID ? null : record.updatedAt,
    status: manager.getStatus(record.userId, record.id),
    toolchain: selection ?? (await toolchain.resolve(record.userId, record.id)),
    ...(record.transportKind === 'http'
      ? { hasRuntimeToken: await hasRuntimeToken(record.userId, record.id, secretStore) }
      : {}),
  };
}

/**
 * The runtime-side effects `remove`/`update` need, behind an interface.
 *
 * These are the only calls in this service that write to another machine or
 * read another module's in-memory state, and the default wiring reaches for
 * module singletons — so they are injectable rather than imported at the call
 * site. Without that, the one code path that runs `rm -rf` on a remote slot
 * cannot be covered by a test that does not own a WSL distribution.
 */
export interface EnvironmentRuntimeEffects {
  /** Whether a runtime install is mid-flight for this environment. */
  hasActiveInstall(userId: string, id: string): boolean;
  /** Stops any run this environment still owns; false when it owns none. */
  cancelActiveRun(userId: string, id: string): boolean;
  /** Deletes the runtime bytes this environment installed; leaves consent alone. */
  removeRuntimeBytes(record: EnvironmentRecord): Promise<void>;
}

/**
 * What a client is told when byte removal fails, whatever the transport. The
 * stderr, host and paths behind it go to the log through `diagnostic`.
 */
const RUNTIME_REMOVAL_FAILED_MESSAGE =
  'The runtime could not be removed from the machine, so the environment was kept. Check that the machine is reachable and try again, or delete the environment without removing the runtime.';

/**
 * Builds the default effects. The SSH runner is a parameter so the remote
 * removal path can be covered without a reachable host.
 */
export function createEnvironmentRuntimeEffects(
  sshRunnerFor: (config: SshEnvironmentConfig) => RuntimeCommandRunner = createSshCommandRunner
): EnvironmentRuntimeEffects {
  return {
    hasActiveInstall: (userId, id) => runtimeLifecycleService.hasActiveInstall(userId, id),
    cancelActiveRun: (userId, id) => runtimeLifecycleService.cancelForEnvironment(userId, id),
    async removeRuntimeBytes(record) {
      if (record.transportKind === 'wsl') {
        await wslProvisioner.removeSlotBytes(environmentConfigFor('wsl', record.config).distro);
        return;
      }
      if (record.transportKind !== 'ssh') return;
      const config = environmentConfigFor('ssh', record.config);
      const remote = await sshRunnerFor(config)(runtimeRemoveSlotBytesScript('remote'));
      if (remote.exitCode !== 0) {
        throw new EnvironmentServiceError(RUNTIME_REMOVAL_FAILED_MESSAGE, 503, {
          reason: 'runtime-removal-failed',
          environmentId: record.id,
          diagnostic: `Could not remove the runtime from "${config.host}": ${remote.stderr.trim() || remote.stdout.trim() || `exit ${remote.exitCode}`}`,
        });
      }
    },
  };
}

const defaultEnvironmentRuntimeEffects = createEnvironmentRuntimeEffects();

/** Told when a user took an environment away; see {@link onEnvironmentWithdrawn}. */
export type EnvironmentWithdrawnListener = (userId: string, environmentId: string) => void;

const withdrawnListeners = new Set<EnvironmentWithdrawnListener>();

/**
 * Subscribes to the user's own actions that take an environment away:
 * Disconnect, disabling it, repointing its config, rotating its token and
 * removing it. Returns the unsubscribe.
 *
 * Deliberately not the connection manager's disconnect, which also runs for
 * dial-in drops and pairing: only these say "stop using this", and work that
 * would otherwise reconnect on its own — a turn waiting to resubmit — has to
 * hear them. Registered rather than imported, because the modules that care
 * already depend on this one.
 *
 * @example
 * const stop = onEnvironmentWithdrawn((userId, id) => reap(userId, id));
 */
export function onEnvironmentWithdrawn(listener: EnvironmentWithdrawnListener): () => void {
  withdrawnListeners.add(listener);
  return () => withdrawnListeners.delete(listener);
}

function notifyEnvironmentWithdrawn(userId: string, environmentId: string): void {
  for (const listener of [...withdrawnListeners]) {
    try {
      listener(userId, environmentId);
    } catch (error) {
      console.warn(
        '[environments] An environment-withdrawn listener failed:',
        error instanceof Error ? error.message : 'unknown error'
      );
    }
  }
}

/**
 * A token the hub could not store. The secret store's own text can name the
 * keychain backend or a path, so the client gets a fixed message and the text
 * goes to the log. A secret-store outage is 503; anything else stays 400.
 */
function tokenStorageFailure(environmentId: string, error: unknown): EnvironmentServiceError {
  const status = statusForTokenPersistFailure(error);
  return new EnvironmentServiceError(
    status === 503
      ? "The hub could not store the runtime token because its secret storage is unavailable. Check the hub's keychain or credential manager and try again."
      : 'The runtime token could not be stored. Check the token and try again.',
    status,
    { reason: 'token-storage-failed', environmentId, diagnostic: diagnosticOf(error) }
  );
}

export function createEnvironmentService(
  repository: EnvironmentRepository = environmentRepository,
  manager: RuntimeConnectionManager = getRuntimeConnectionManager(),
  publish: (userId: string) => void = publishEnvironmentInvalidation,
  secretStore: SecretStore = bunSecretStore,
  runtimeEffects: EnvironmentRuntimeEffects = defaultEnvironmentRuntimeEffects,
  toolchain: ToolchainService = toolchainService,
  withdrawn: EnvironmentWithdrawnListener = notifyEnvironmentWithdrawn,
  credentialDatabasePath: () => string = () => getConfig().database.path
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

  async function lockTokenEdit(userId: string, id: string): Promise<() => Promise<void>> {
    try {
      return await acquireToolchainCredentialLock(credentialDatabasePath(), userId, id, 'edit');
    } catch (error) {
      throw new EnvironmentServiceError(
        'The runtime token for this environment is being changed or backed up. Try again in a moment.',
        409,
        { reason: 'token-edit-locked', environmentId: id, diagnostic: diagnosticOf(error) }
      );
    }
  }

  return {
    async list(userId) {
      const rows = await repository.list(userId);
      const selections = await toolchain.listByUser(userId);
      return await Promise.all(
        [localRecord(userId), ...rows].map((record) =>
          toEnvironment(
            record,
            manager,
            secretStore,
            toolchain,
            selections.get(record.id) ?? DEFAULT_TOOLCHAIN_SELECTION
          )
        )
      );
    },

    async find(userId, id) {
      const record = await findRecord(userId, id);
      return record ? await toEnvironment(record, manager, secretStore, toolchain) : null;
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

      const release = token ? await lockTokenEdit(userId, input.id) : undefined;
      try {
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
            throw tokenStorageFailure(record.id, error);
          }
        }

        publish(userId);
        return await toEnvironment(record, manager, secretStore, toolchain);
      } finally {
        await release?.();
      }
    },

    async update(userId, id, input) {
      if (id === LOCAL_ENVIRONMENT_ID) {
        throw new EnvironmentServiceError('The Local environment cannot be changed.', 409);
      }
      if (runtimeEffects.hasActiveInstall(userId, id)) {
        throw new EnvironmentServiceError(
          `Environment "${id}" has a runtime install in progress. Cancel it or wait before editing.`,
          409
        );
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
      const release = token !== undefined ? await lockTokenEdit(userId, id) : undefined;
      try {
        const definitionUpdate =
          token === undefined ? rowUpdate : { ...rowUpdate, rotatesToken: true };
        const updated =
          Object.keys(definitionUpdate).length > 0
            ? await repository.update(userId, id, definitionUpdate)
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
                allowInstalls: current.allowInstalls,
              });
            }
            throw tokenStorageFailure(id, error);
          }
        }

        // A live connection was opened from the definition as it stood before this
        // write. Disabling the environment, repointing its transport, or rotating
        // the token must drop it, or the reported status keeps describing the
        // persisted config while every tool call keeps reaching the old endpoint.
        if (input.enabled === false || input.config !== undefined || token !== undefined) {
          withdrawn(userId, id);
          manager.disconnect(userId, id);
          // Disconnect keeps health for transient drops; a config repoint must
          // not leave the card showing the previous host's version/digest.
          if (input.config !== undefined) {
            manager.clearHealth(userId, id);
          }
        } else if (input.enabled === true) {
          // Calls that reached it while it was disabled each recorded a failure,
          // which can already have latched the backoff. Re-enabling is the answer
          // to that, so clear it here rather than making the user press Connect.
          manager.clearBackoff(userId, id);
        }
        publish(userId);
        return await toEnvironment(updated, manager, secretStore, toolchain);
      } finally {
        await release?.();
      }
    },

    async remove(userId, id, options = {}) {
      if (id === LOCAL_ENVIRONMENT_ID) {
        throw new EnvironmentServiceError('The Local environment cannot be removed.', 409);
      }
      if (runtimeEffects.hasActiveInstall(userId, id)) {
        throw new EnvironmentServiceError(
          `Environment "${id}" has a runtime install in progress. Cancel it or wait before deleting.`,
          409
        );
      }
      const existing = await repository.find(userId, id);
      if (!existing) {
        throw new EnvironmentServiceError(`Environment "${id}" was not found.`, 404);
      }

      // Preflight references before touching anything, so a delete that is
      // going to be refused refuses cleanly: it must not disconnect a live
      // runtime or wipe remote bytes on its way to a 409. Byte cleanup then
      // stays before the DB delete so a failed cleanup remains retriable.
      const gate = await repository.removable(userId, id);
      if (gate === 'referenced') {
        throw new EnvironmentServiceError(
          `Environment "${id}" is still used by one or more chats or MCP servers.`,
          409
        );
      }
      if (gate === 'missing') {
        throw new EnvironmentServiceError(`Environment "${id}" was not found.`, 404);
      }

      // Only now: disconnect before byte cleanup so a live spawn is not holding
      // the binary being deleted.
      withdrawn(userId, id);
      manager.disconnect(userId, id);

      // A staged download does not block this delete — its bytes land in the
      // hub's version-keyed cache, where they are harmless and shared. What is
      // not harmless is the run itself: it would keep streaming log lines about
      // an environment that no longer exists, against a card nothing can open.
      runtimeEffects.cancelActiveRun(userId, id);

      if (options.removeRuntime) {
        try {
          await runtimeEffects.removeRuntimeBytes(existing);
        } catch (error) {
          if (error instanceof EnvironmentServiceError) throw error;
          throw new EnvironmentServiceError(RUNTIME_REMOVAL_FAILED_MESSAGE, 503, {
            reason: 'runtime-removal-failed',
            environmentId: id,
            diagnostic: diagnosticOf(error),
          });
        }
      }

      const result = await repository.remove(userId, id);
      if (result === 'referenced') {
        throw new EnvironmentServiceError(
          `Environment "${id}" is still used by one or more chats or MCP servers.`,
          409
        );
      }
      if (result === 'missing') {
        throw new EnvironmentServiceError(`Environment "${id}" was not found.`, 404);
      }

      await removeRuntimeToken(userId, id, secretStore);
      publish(userId);
    },

    async connect(userId, id) {
      await requireRecord(userId, id);
      try {
        // A deliberate connect clears any backoff: the user is telling us the
        // cause was fixed, so waiting out a retry window would be theatre. The
        // outcome is not read here because the environment this returns already
        // carries it — a connect that left an image downloading answers with
        // `connecting` plus `pullingImage`, which is what the card renders and
        // what an unsubscribed client can poll.
        await manager.connectInteractive(userId, id);
      } catch (error) {
        // The row can be removed between the guard above and the manager's own
        // lookup, which reports it as an unavailable runtime. That is a missing
        // resource, not a connect conflict, so re-read before choosing a status.
        if (!(await findRecord(userId, id))) {
          throw new EnvironmentServiceError(`Environment "${id}" was not found.`, 404);
        }
        // A refused or failed connect keeps its type, so the route answers 503
        // with the fixed text instead of a 409 carrying the manager's diagnostic.
        if (isEnvironmentUnavailable(error)) throw error;
        throw new EnvironmentServiceError(
          'The environment could not be connected. Check its configuration and that the machine is reachable, then try again.',
          409,
          { reason: 'connect-failed', environmentId: id, diagnostic: diagnosticOf(error) }
        );
      }
      const record = await requireRecord(userId, id);
      return await toEnvironment(record, manager, secretStore, toolchain);
    },

    async disconnect(userId, id) {
      const record = await requireRecord(userId, id);
      withdrawn(userId, id);
      manager.disconnect(userId, id);
      return await toEnvironment(record, manager, secretStore, toolchain);
    },
  };
}

export const environmentService = createEnvironmentService();
