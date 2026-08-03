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
import { LOCAL_ENVIRONMENT_ID, SshFailureReasonSchema } from '@mangostudio/shared/environments';
import type { RuntimeErrorCode } from '@mangostudio/shared/runtime-protocol';
import { Value } from '@sinclair/typebox/value';
import { probeRuntimeSlots } from '../../cli/runtime-slot-probe';
import { getVersion } from '../../lib/config';
import { resolveRuntimeLaunchCommand } from '../../lib/runtime-paths';
import {
  assertEnvironmentConfig,
  environmentConfigFor,
  isEnvironmentConfigValid,
} from '../../modules/environments/domain/environment-config';
import { wslLaunchCommand } from '../../modules/environments/domain/wsl-runtime-release';
import { environmentRepository } from '../../modules/environments/infrastructure/environment-repository';
import { wslProvisioner } from '../../modules/environments/infrastructure/wsl-provisioner';
import { publishEnvironmentInvalidation } from '../realtime/environment-invalidation';
import { connectHttpRuntime } from './connect-http-runtime';
import { connectSshRuntime } from './connect-ssh-runtime';
import { RuntimeClient } from './runtime-client';
import { spawnRuntimeChild } from './spawn-runtime-child';

export interface RuntimeEnvironmentDefinition {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly transportKind: EnvironmentTransportKind;
  readonly config: unknown;
  readonly enabled: boolean;
}

/**
 * Why a connection is being closed. Transports that can say so on the wire —
 * a WebSocket close code, say — turn this into something the peer can act on:
 * a superseded runtime must not redial into a loop, and a released one should.
 */
type RuntimeConnectionCloseReason = 'released' | 'superseded';

export interface ManagedRuntimeConnection {
  readonly client: RuntimeClient;
  /** May resolve when an out-of-process runtime is gone; in-process is immediate. */
  close(reason?: RuntimeConnectionCloseReason): void | Promise<void>;
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
  /** Known once a definition resolved; decides whether a backoff applies. */
  transportKind?: EnvironmentTransportKind;
  connection?: ManagedRuntimeConnection;
  connecting?: Promise<RuntimeClient>;
  /** Consecutive failures since the last connection that proved itself. */
  failureCount: number;
  /** Epoch ms of the last successful handshake, used to judge that. */
  connectedAtMs?: number;
  /**
   * Epoch ms before which a lazy connect fails fast instead of respawning.
   * `Infinity` latches the environment until someone connects it explicitly.
   */
  retryAfterMs: number;
}

/**
 * 1s, 2s, 4s, 8s — the fifth failure hits the attempt cap and latches the
 * environment instead of waiting again. `RECONNECT_MAX_DELAY_MS` only binds if
 * `MAX_RECONNECT_ATTEMPTS` grows past the point where doubling reaches it.
 */
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * How long a connection must survive to count as healthy. A runtime that dies
 * moments after every handshake would otherwise clear the failure count on each
 * attempt and never reach the cap, respawning for as long as callers keep
 * asking — the crash loop the backoff exists to stop.
 */
const HEALTHY_CONNECTION_MS = 10_000;

/**
 * Transports where the hub cannot open the connection at all — the runtime
 * dials in when it is ready. Nothing here is retryable by the hub, so a backoff
 * would only be a timer counting down against an event it cannot cause.
 */
const DIAL_IN_TRANSPORT_KINDS = new Set<EnvironmentTransportKind>(['websocket']);

function isDialIn(transportKind: EnvironmentTransportKind | undefined): boolean {
  return transportKind !== undefined && DIAL_IN_TRANSPORT_KINDS.has(transportKind);
}

function connectionKey(userId: string, environmentId: string): string {
  return `${userId}:${environmentId}`;
}

/**
 * Backoff is a deadline rather than a timer: nothing is scheduled, so a
 * disabled, deleted, or simply unused environment never respawns on its own,
 * and there is no pending callback for shutdown to forget to cancel. The next
 * caller that actually needs the runtime pays for the retry.
 */
function retryDeadline(failureCount: number, errorCode: RuntimeErrorCode, dialIn: boolean): number {
  // Latching a dial-in transport would be a dead state no button can clear:
  // the hub never dials, so nothing it does can produce the connection the
  // deadline is holding back. That includes a protocol mismatch — a runtime
  // that was upgraded and redials has to be able to take over.
  if (dialIn) return 0;
  // A stale binary cannot fix itself by being asked again; require a reinstall
  // and an explicit reconnect rather than burning attempts on it.
  if (errorCode === 'PROTOCOL_MISMATCH' || failureCount >= MAX_RECONNECT_ATTEMPTS) {
    return Number.POSITIVE_INFINITY;
  }
  const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (failureCount - 1), RECONNECT_MAX_DELAY_MS);
  return Date.now() + delay;
}

function describeBackoff(environmentId: string, entry: RuntimeConnectionEntry): string {
  if (entry.retryAfterMs === Number.POSITIVE_INFINITY) {
    return `Environment "${environmentId}" stopped retrying after ${entry.failureCount} failed connection attempt(s). Reconnect it once the cause is fixed.`;
  }
  const seconds = Math.max(1, Math.ceil((entry.retryAfterMs - Date.now()) / 1_000));
  return `Environment "${environmentId}" is unavailable; the next connection attempt is allowed in ${seconds}s.`;
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

/**
 * What the card says about the peer's release. Remote transports connect
 * across a release boundary on purpose — `requireMatchingRelease` is off for
 * them — so the drift has to be reported rather than refused, and the compare
 * happens here because the hub is the only side that holds both strings.
 */
function peerRelease(
  runtimeVersion: string | undefined
): Pick<EnvironmentConnectionStatus, 'runtimeVersion' | 'runtimeVersionDrift'> {
  if (!runtimeVersion) return {};
  return { runtimeVersion, runtimeVersionDrift: runtimeVersion !== getVersion() };
}

function statusErrorCode(error: unknown): RuntimeErrorCode {
  return error instanceof RuntimeRemoteError ? error.code : 'RUNTIME_UNAVAILABLE';
}

/**
 * The transport-specific half of a failure, when the connector could name one.
 *
 * Only ssh produces it today, and it has to travel as data because its client
 * reports an unverified host key, a refused credential and an unreachable host
 * with one exit status — none of which `errorCode` can distinguish, and all of
 * which need a different fix. Validated rather than trusted: the value comes
 * back through an untyped details bag.
 */
function failureDetail(error: unknown): Pick<EnvironmentConnectionStatus, 'sshFailureReason'> {
  const reason = error instanceof RuntimeRemoteError ? error.details?.sshFailureReason : undefined;
  return Value.Check(SshFailureReasonSchema, reason) ? { sshFailureReason: reason } : {};
}

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

  /**
   * Opens a connection, or returns the live one. `force` marks the deliberate
   * connect actions — a user pressing Connect, or a route acting on their
   * behalf — which clear a backoff instead of being held by it.
   */
  async connect(
    userId: string,
    environmentId: string,
    options: { readonly force?: boolean } = {}
  ): Promise<RuntimeClient> {
    const key = connectionKey(userId, environmentId);
    const current = this.#entries.get(key);
    if (current?.connection) return current.connection.client;
    if (current?.connecting) return await current.connecting;

    const entry = current ?? {
      revision: 0,
      status: { state: 'disconnected' as const },
      failureCount: 0,
      retryAfterMs: 0,
    };
    this.#entries.set(key, entry);
    if (options.force) {
      entry.failureCount = 0;
      entry.retryAfterMs = 0;
    } else if (Date.now() < entry.retryAfterMs) {
      throw unavailable(describeBackoff(environmentId, entry));
    }
    const revision = ++entry.revision;
    entry.status = { state: 'connecting', ...this.#cachedPeer(entry) };
    this.#publish(userId);

    const connecting = this.#resolveEnvironment(userId, environmentId)
      .then((definition) => {
        if (!definition) {
          throw unavailable(`Environment "${environmentId}" was not found.`);
        }
        entry.transportKind = definition.transportKind;
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
        entry.connectedAtMs = Date.now();
        // The failure count is not cleared here: a handshake only shows the
        // runtime started, and one that dies straight after every start is
        // exactly the case the cap has to catch. `#markUnavailable` clears it
        // once the connection has actually lasted.
        entry.retryAfterMs = 0;
        entry.status = {
          state: 'connected',
          manifest: connection.client.manifest,
          ...peerRelease(connection.client.runtimeVersion),
        };
        this.#publish(userId);
        return connection.client;
      })
      .catch((error: unknown) => {
        if (entry.revision === revision) {
          const errorCode = statusErrorCode(error);
          const dialIn = isDialIn(entry.transportKind);
          entry.connection = undefined;
          entry.failureCount = dialIn ? 0 : entry.failureCount + 1;
          entry.retryAfterMs = retryDeadline(entry.failureCount, errorCode, dialIn);
          entry.status = {
            // A dial-in environment nobody has dialed into yet is not broken,
            // it is waiting. `error` would put a red rail on a card whose only
            // problem is that the runtime has not been started on that machine.
            state: dialIn ? 'disconnected' : 'error',
            errorCode,
            ...failureDetail(error),
            ...this.#cachedPeer(entry),
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

  /**
   * Takes over a connection the hub did not open.
   *
   * `connect()` cannot express this: it resolves an environment, dials it, and
   * hands back a client. For a dial-in transport the socket already exists and
   * the definition still has to be honoured — a disabled environment must be
   * refused here too, or disabling one would only stop the connections the hub
   * initiates. The revision bump both supersedes an incumbent connection and
   * invalidates any `connect()` still in flight, and the failure history goes
   * with it: a runtime that dialed in has proved the environment reachable,
   * whatever the hub's own attempts recorded while it was not.
   */
  async adopt(
    userId: string,
    environmentId: string,
    open: (onUnavailable: () => void) => Promise<ManagedRuntimeConnection>
  ): Promise<RuntimeClient> {
    const definition = await this.#resolveEnvironment(userId, environmentId);
    if (!definition) {
      throw unavailable(`Environment "${environmentId}" was not found.`);
    }
    if (!definition.enabled) {
      throw unavailable(`Environment "${definition.id}" is disabled.`);
    }

    const key = connectionKey(userId, environmentId);
    const entry = this.#entries.get(key) ?? {
      revision: 0,
      status: { state: 'disconnected' as const },
      failureCount: 0,
      retryAfterMs: 0,
    };
    this.#entries.set(key, entry);
    entry.transportKind = definition.transportKind;

    const revision = ++entry.revision;
    const superseded = entry.connection;
    entry.connection = undefined;
    entry.connecting = undefined;
    void superseded?.close('superseded');
    entry.status = { state: 'connecting', ...this.#cachedPeer(entry) };
    this.#publish(userId);

    let connection: ManagedRuntimeConnection;
    try {
      connection = await open(() => this.#markUnavailable(key, userId, revision));
    } catch (error) {
      if (entry.revision === revision) {
        entry.status = { state: 'disconnected', ...this.#cachedPeer(entry) };
        this.#publish(userId);
      }
      throw normalizeUnavailable(error);
    }
    if (entry.revision !== revision) {
      void connection.close('superseded');
      throw unavailable('Runtime connection was superseded while it was handshaking.');
    }

    entry.connection = connection;
    entry.connectedAtMs = Date.now();
    entry.failureCount = 0;
    entry.retryAfterMs = 0;
    entry.status = {
      state: 'connected',
      manifest: connection.client.manifest,
      ...peerRelease(connection.client.runtimeVersion),
    };
    this.#publish(userId);
    return connection.client;
  }

  disconnect(userId: string, environmentId: string): void {
    const entry = this.#entries.get(connectionKey(userId, environmentId));
    if (!entry) return;

    this.#release(entry);
    this.#publish(userId);
  }

  /**
   * Releases every live connection and resolves once their processes are gone.
   * Runtime children are the hub's responsibility, so shutdown waits for them
   * rather than exiting mid-kill and leaving orphans behind.
   */
  async closeAll(): Promise<void> {
    const closings = [...this.#entries.values()].map((entry) => this.#release(entry));
    await Promise.all(closings);
  }

  /**
   * Takes an environment down deliberately, which also clears its failure
   * history: the next connect is a fresh decision, not a continuation of the
   * one that was just abandoned.
   */
  #release(entry: RuntimeConnectionEntry): void | Promise<void> {
    entry.revision += 1;
    const closed = entry.connection?.close('released');
    entry.connection = undefined;
    entry.connecting = undefined;
    entry.connectedAtMs = undefined;
    entry.failureCount = 0;
    entry.retryAfterMs = 0;
    entry.status = { state: 'disconnected', ...this.#cachedPeer(entry) };
    return closed;
  }

  /**
   * Forgets a backoff without touching a live connection. Re-enabling an
   * environment says the cause was addressed, and the failures it collected
   * while disabled — every lazy call reaching it earned one — would otherwise
   * outlive that, latching it until someone pressed Connect.
   */
  clearBackoff(userId: string, environmentId: string): void {
    const entry = this.#entries.get(connectionKey(userId, environmentId));
    if (!entry || (entry.failureCount === 0 && entry.retryAfterMs === 0)) return;

    entry.failureCount = 0;
    entry.retryAfterMs = 0;
    if (entry.status.state === 'error') {
      entry.status = { state: 'disconnected', ...this.#cachedPeer(entry) };
    }
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

    // A runtime whose path style differs from the hub's is addressed on its own
    // terms: tools resolve `~` and relative input through the connection's
    // manifest, and the runtime re-checks the result against its own filesystem.
    return await connector(definition, onUnavailable);
  }

  /**
   * A runtime that dies is disconnected, not broken: the target is usually
   * still there and the next caller should get a fresh process. The backoff
   * deadline is what keeps a crash loop from respawning on every tool call.
   */
  #markUnavailable(key: string, userId: string, revision: number): void {
    const entry = this.#entries.get(key);
    if (!entry || entry.revision !== revision || !entry.connection) return;

    // The child is already gone; nothing waits on the kill that confirms it.
    void entry.connection.close();
    entry.connection = undefined;
    // A connection that ran for a while and then died starts a fresh count; one
    // that died on arrival continues the old one toward the cap.
    const healthy = Date.now() - (entry.connectedAtMs ?? 0) >= HEALTHY_CONNECTION_MS;
    const dialIn = isDialIn(entry.transportKind);
    entry.connectedAtMs = undefined;
    entry.failureCount = dialIn ? 0 : healthy ? 1 : entry.failureCount + 1;
    entry.retryAfterMs = retryDeadline(entry.failureCount, 'RUNTIME_UNAVAILABLE', dialIn);
    entry.status = {
      // A latched deadline is what `error` means here, so read it rather than
      // re-deriving the cap and drifting from whatever else latches.
      state: entry.retryAfterMs === Number.POSITIVE_INFINITY ? 'error' : 'disconnected',
      errorCode: 'RUNTIME_UNAVAILABLE',
      ...this.#cachedPeer(entry),
    };
    this.#publish(userId);
  }

  /**
   * What is still true about the peer once the connection to it is gone: what
   * it could do, and which release said so. Carried across states so a card
   * that just lost its runtime still describes the machine it lost, rather
   * than blanking every field the moment the socket drops.
   */
  #cachedPeer(
    entry: RuntimeConnectionEntry
  ): Pick<EnvironmentConnectionStatus, 'manifest' | 'runtimeVersion'> {
    return {
      ...(entry.status.manifest ? { manifest: entry.status.manifest } : {}),
      ...(entry.status.runtimeVersion
        ? {
            runtimeVersion: entry.status.runtimeVersion,
            runtimeVersionDrift: entry.status.runtimeVersionDrift ?? false,
          }
        : {}),
    };
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
  // Local runs in this process, but it is still a runtime on somebody's
  // machine: it answers to the `host` slot's consent like every other one. A
  // user who narrows that slot gets a read-only Local, which is the point of
  // being able to narrow it. Absence resolves to full, so the default is
  // unchanged and no install has to have run.
  const [probe] = (await probeRuntimeSlots()).filter((slot) => slot.slot === 'host');
  const host = createLocalRuntimeHost({
    runtimeVersion: version,
    slot: 'host',
    ...(probe && !probe.error ? { allow: probe.config.allow } : {}),
  });
  const connection: InProcessRuntimeConnection = await connectInProcessRuntime(host, {
    hubVersion: version,
  });
  return {
    client: new RuntimeClient(connection.client, onUnavailable),
    close: () => connection.close(),
  };
}

async function connectStdioRuntime(
  definition: RuntimeEnvironmentDefinition,
  onUnavailable: () => void
): Promise<ManagedRuntimeConnection> {
  const config = environmentConfigFor('stdio', definition.config);
  const connection = await spawnRuntimeChild({
    environmentId: definition.id,
    launch: resolveRuntimeLaunchCommand(config.binaryPath),
    ...(config.cwd ? { cwd: config.cwd } : {}),
    hubVersion: getVersion(),
    onClosed: onUnavailable,
  });
  return {
    // Both signals are wired on purpose and `#markUnavailable` is idempotent, so
    // a child that dies mid-request reporting through both costs nothing. Neither
    // covers the other: the pipe closing catches a death with no request in
    // flight, and a request failing catches a child that answers but is gone.
    client: new RuntimeClient(connection.client, onUnavailable),
    close: () => connection.close(),
  };
}

/**
 * A WSL distribution is a launcher over the stdio transport rather than a
 * protocol of its own, so the only work here is making sure a runtime the hub's
 * own release built for Linux is in the distribution first. That is also how a
 * hub update is absorbed: the stale binary is replaced instead of failing the
 * handshake with nothing the user can act on.
 */
async function connectWslRuntime(
  definition: RuntimeEnvironmentDefinition,
  onUnavailable: () => void
): Promise<ManagedRuntimeConnection> {
  if (process.platform !== 'win32') {
    throw unavailable(
      `Environment "${definition.id}" runs in a WSL distribution, which only a Windows host can start.`
    );
  }
  const { distro } = environmentConfigFor('wsl', definition.config);
  await wslProvisioner.ensure(distro);

  const connection = await spawnRuntimeChild({
    environmentId: definition.id,
    launch: wslLaunchCommand(distro),
    hubVersion: getVersion(),
    onClosed: onUnavailable,
  });
  return {
    client: new RuntimeClient(connection.client, onUnavailable),
    close: () => connection.close(),
  };
}

/**
 * The connector for transports the hub never dials. It is registered rather
 * than omitted so `connect()` keeps its meaning: asking for a connection the
 * hub cannot open fails with a message naming what will open it, instead of
 * "the websocket transport is not available yet", which is not true.
 */
function refuseDialInRuntime(
  definition: RuntimeEnvironmentDefinition
): Promise<ManagedRuntimeConnection> {
  return Promise.reject(
    unavailable(
      `Environment "${definition.id}" connects when its runtime dials in. Install the runtime on that machine and run "mangostudio-runtime connect".`
    )
  );
}

let managerInstance: RuntimeConnectionManager | undefined;

export function getRuntimeConnectionManager(): RuntimeConnectionManager {
  managerInstance ??= new RuntimeConnectionManager({
    resolveEnvironment,
    connectors: {
      'in-process': connectLocalRuntime,
      stdio: connectStdioRuntime,
      wsl: connectWslRuntime,
      websocket: refuseDialInRuntime,
      http: connectHttpRuntime,
      ssh: connectSshRuntime,
    },
    publish: publishEnvironmentInvalidation,
  });
  return managerInstance;
}

/** Releases every runtime connection this process opened. Used by shutdown. */
export async function closeAllRuntimeConnections(): Promise<void> {
  await managerInstance?.closeAll();
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
