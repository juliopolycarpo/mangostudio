import {
  connectInProcessRuntime,
  createLocalRuntimeHost,
  type InProcessRuntimeConnection,
  RuntimeRemoteError,
} from '@mangostudio/runtime';
import type {
  EnvironmentConnectionStatus,
  EnvironmentTransportKind,
} from '@mangostudio/shared/environments';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type {
  RuntimeCapabilityManifest,
  RuntimeErrorCode,
} from '@mangostudio/shared/runtime-protocol';
import { getVersion } from '../../lib/config';
import {
  assertEnvironmentConfig,
  isEnvironmentConfigValid,
} from '../../modules/environments/domain/environment-config';
import { environmentRepository } from '../../modules/environments/infrastructure/environment-repository';
import { publishEnvironmentInvalidation } from '../realtime/environment-invalidation';
import { RuntimeClient } from './runtime-client';

export interface RuntimeEnvironmentDefinition {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly transportKind: EnvironmentTransportKind;
  readonly config: unknown;
  readonly enabled: boolean;
}

export interface ManagedRuntimeConnection {
  readonly client: RuntimeClient;
  close(): void;
}

export type RuntimeEnvironmentResolver = (
  userId: string,
  environmentId: string
) => Promise<RuntimeEnvironmentDefinition | null>;

export type RuntimeEnvironmentConnector = (
  definition: RuntimeEnvironmentDefinition,
  onUnavailable: () => void
) => Promise<ManagedRuntimeConnection>;

export interface RuntimeConnectionManagerOptions {
  readonly resolveEnvironment: RuntimeEnvironmentResolver;
  readonly connectors: Partial<Record<EnvironmentTransportKind, RuntimeEnvironmentConnector>>;
  readonly publish?: (userId: string) => void;
}

interface RuntimeConnectionEntry {
  revision: number;
  status: EnvironmentConnectionStatus;
  connection?: ManagedRuntimeConnection;
  connecting?: Promise<RuntimeClient>;
}

function connectionKey(userId: string, environmentId: string): string {
  return `${userId}:${environmentId}`;
}

function unavailable(message: string): RuntimeRemoteError {
  return new RuntimeRemoteError('RUNTIME_UNAVAILABLE', message);
}

/**
 * Callers branch on `RUNTIME_UNAVAILABLE` to decide that a tool call failed
 * because its target is gone, so every connect failure keeps that code when it
 * is thrown. The specific cause is preserved separately on the connection
 * status, which is what the Environments UI reads.
 */
function normalizeUnavailable(error: unknown): RuntimeRemoteError {
  return error instanceof RuntimeRemoteError && error.code === 'RUNTIME_UNAVAILABLE'
    ? error
    : unavailable(error instanceof Error ? error.message : String(error));
}

function statusErrorCode(error: unknown): RuntimeErrorCode {
  return error instanceof RuntimeRemoteError ? error.code : 'RUNTIME_UNAVAILABLE';
}

/**
 * Built-in tools still expand `~` and join relative paths with the hub's own
 * `node:path` and `HOME` before handing the result to a runtime client (see
 * `resolveWorkdirRelativePath`). That is sound only while both ends agree on
 * path style, so a runtime that disagrees is refused at connect rather than fed
 * paths it would misread. Lift this once resolution moves behind the manifest —
 * WSL and SSH targets need that before they can connect.
 */
const HUB_PATH_STYLE: RuntimeCapabilityManifest['pathStyle'] =
  process.platform === 'win32' ? 'win32' : 'posix';

export class RuntimeConnectionManager {
  readonly #connectors: RuntimeConnectionManagerOptions['connectors'];
  readonly #entries = new Map<string, RuntimeConnectionEntry>();
  readonly #publish: (userId: string) => void;
  readonly #resolveEnvironment: RuntimeEnvironmentResolver;

  constructor(options: RuntimeConnectionManagerOptions) {
    this.#connectors = options.connectors;
    this.#publish = options.publish ?? (() => undefined);
    this.#resolveEnvironment = options.resolveEnvironment;
  }

  getStatus(userId: string, environmentId: string): EnvironmentConnectionStatus {
    return (
      this.#entries.get(connectionKey(userId, environmentId))?.status ?? {
        state: 'disconnected',
      }
    );
  }

  async getClient(
    userId: string,
    environmentId: string = LOCAL_ENVIRONMENT_ID
  ): Promise<RuntimeClient> {
    const key = connectionKey(userId, environmentId);
    const entry = this.#entries.get(key);
    if (entry?.connection) return entry.connection.client;
    if (entry?.connecting) return await entry.connecting;
    return await this.connect(userId, environmentId);
  }

  async connect(userId: string, environmentId: string): Promise<RuntimeClient> {
    const key = connectionKey(userId, environmentId);
    const current = this.#entries.get(key);
    if (current?.connection) return current.connection.client;
    if (current?.connecting) return await current.connecting;

    const entry = current ?? {
      revision: 0,
      status: { state: 'disconnected' as const },
    };
    this.#entries.set(key, entry);
    const revision = ++entry.revision;
    entry.status = { state: 'connecting', ...this.#cachedManifest(entry) };
    this.#publish(userId);

    const connecting = this.#resolveEnvironment(userId, environmentId)
      .then((definition) => {
        if (!definition) {
          throw unavailable(`Environment "${environmentId}" was not found.`);
        }
        return this.#openConnection(definition, () => {
          this.#markUnavailable(key, userId, revision);
        });
      })
      .then((connection) => {
        if (entry.revision !== revision) {
          connection.close();
          throw unavailable('Runtime connection was closed.');
        }
        entry.connection = connection;
        entry.status = {
          state: 'connected',
          manifest: connection.client.manifest,
        };
        this.#publish(userId);
        return connection.client;
      })
      .catch((error: unknown) => {
        if (entry.revision === revision) {
          entry.connection = undefined;
          entry.status = {
            state: 'error',
            errorCode: statusErrorCode(error),
            ...this.#cachedManifest(entry),
          };
          this.#publish(userId);
        }
        throw normalizeUnavailable(error);
      })
      .finally(() => {
        if (entry.connecting === connecting) entry.connecting = undefined;
      });
    entry.connecting = connecting;
    return await connecting;
  }

  disconnect(userId: string, environmentId: string): void {
    const key = connectionKey(userId, environmentId);
    const entry = this.#entries.get(key);
    if (!entry) return;

    entry.revision += 1;
    entry.connection?.close();
    entry.connection = undefined;
    entry.connecting = undefined;
    entry.status = { state: 'disconnected', ...this.#cachedManifest(entry) };
    this.#publish(userId);
  }

  async #openConnection(
    definition: RuntimeEnvironmentDefinition,
    onUnavailable: () => void
  ): Promise<ManagedRuntimeConnection> {
    if (!definition.enabled) {
      throw unavailable(`Environment "${definition.id}" is disabled.`);
    }
    if (!isEnvironmentConfigValid(definition.transportKind, definition.config)) {
      throw unavailable(`Environment "${definition.id}" has invalid configuration.`);
    }
    assertEnvironmentConfig(definition.transportKind, definition.config);

    const connector = this.#connectors[definition.transportKind];
    if (!connector) {
      throw unavailable(
        `The ${definition.transportKind} environment transport is not available yet.`
      );
    }

    const connection = await connector(definition, onUnavailable);
    const { pathStyle } = connection.client.manifest;
    if (pathStyle !== HUB_PATH_STYLE) {
      connection.close();
      throw unavailable(
        `Environment "${definition.id}" uses ${pathStyle} paths, which this host cannot address yet.`
      );
    }
    return connection;
  }

  #markUnavailable(key: string, userId: string, revision: number): void {
    const entry = this.#entries.get(key);
    if (!entry || entry.revision !== revision || !entry.connection) return;

    entry.connection.close();
    entry.connection = undefined;
    entry.status = {
      state: 'error',
      errorCode: 'RUNTIME_UNAVAILABLE',
      ...this.#cachedManifest(entry),
    };
    this.#publish(userId);
  }

  #cachedManifest(
    entry: RuntimeConnectionEntry
  ): Pick<EnvironmentConnectionStatus, 'manifest'> | Record<string, never> {
    return entry.status.manifest ? { manifest: entry.status.manifest } : {};
  }
}

async function resolveEnvironment(
  userId: string,
  environmentId: string
): Promise<RuntimeEnvironmentDefinition | null> {
  if (environmentId === LOCAL_ENVIRONMENT_ID) {
    return {
      id: LOCAL_ENVIRONMENT_ID,
      userId,
      name: 'Local',
      transportKind: 'in-process',
      config: {},
      enabled: true,
    };
  }
  return await environmentRepository.find(userId, environmentId);
}

async function connectLocalRuntime(
  _definition: RuntimeEnvironmentDefinition,
  onUnavailable: () => void
): Promise<ManagedRuntimeConnection> {
  const version = getVersion();
  const host = createLocalRuntimeHost({ runtimeVersion: version });
  const connection: InProcessRuntimeConnection = await connectInProcessRuntime(host, {
    hubVersion: version,
  });
  return {
    client: new RuntimeClient(connection.client, onUnavailable),
    close: () => connection.close(),
  };
}

let managerInstance: RuntimeConnectionManager | undefined;

export function getRuntimeConnectionManager(): RuntimeConnectionManager {
  managerInstance ??= new RuntimeConnectionManager({
    resolveEnvironment,
    connectors: { 'in-process': connectLocalRuntime },
    publish: publishEnvironmentInvalidation,
  });
  return managerInstance;
}

export function getRuntimeClient(
  userId = 'local',
  environmentId: string = LOCAL_ENVIRONMENT_ID
): Promise<RuntimeClient> {
  return getRuntimeConnectionManager().getClient(userId, environmentId);
}

export function setRuntimeConnectionManagerForTests(
  manager: RuntimeConnectionManager | undefined
): void {
  managerInstance = manager;
}
