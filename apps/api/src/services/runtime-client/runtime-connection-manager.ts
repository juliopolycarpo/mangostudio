import {
  connectInProcessRuntime,
  createLocalRuntimeHost,
  createSingleUserHostExternalAgentIsolation,
  createSlotConsentSource,
  type InProcessRuntimeConnection,
  RuntimeRemoteError,
} from '@mangostudio/runtime';
import type {
  EnvironmentConnectionStatus,
  EnvironmentTransportKind,
} from '@mangostudio/shared/environments';
import {
  ContainerFailureReasonSchema,
  LOCAL_ENVIRONMENT_ID,
  LOCAL_ENVIRONMENT_NAME,
  SshFailureReasonSchema,
} from '@mangostudio/shared/environments';
import type { ExternalIdentityIsolation } from '@mangostudio/shared/external-agents';
import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';
import type { RuntimeErrorCode } from '@mangostudio/shared/runtime-protocol';
import { Value } from '@sinclair/typebox/value';
import { probeRuntimeSlots } from '../../cli/runtime-slot-probe';
import { getDb } from '../../db/database';
import { getVersion } from '../../lib/config';
import { resolveRuntimeLaunchCommand } from '../../lib/runtime-paths';
import {
  assertEnvironmentConfig,
  environmentConfigFor,
  isEnvironmentConfigValid,
} from '../../modules/environments/domain/environment-config';
import { wslLaunchCommand } from '../../modules/environments/domain/wsl-runtime-release';
import { environmentRepository } from '../../modules/environments/infrastructure/environment-repository';
import { resolveWslExecutable } from '../../modules/environments/infrastructure/wsl-executable';
import { wslProvisioner } from '../../modules/environments/infrastructure/wsl-provisioner';
import { publishEnvironmentInvalidation } from '../realtime/environment-invalidation';
import { connectContainerRuntime } from './connect-container-runtime';
import { connectHttpRuntime } from './connect-http-runtime';
import { connectSshRuntime } from './connect-ssh-runtime';
import { capabilityManifestFromHealth } from './manifest-from-health';
import { RuntimeClient } from './runtime-client';
import { type RuntimeLaunchFailure, spawnRuntimeChild } from './spawn-runtime-child';

/** Last `runtime.health` retained across disconnect the way the manifest is. */
export interface CachedRuntimeHealth {
  readonly health: RuntimeHealthReport;
  readonly readAtMs: number;
}

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

/**
 * Closes a connection the hub is no longer waiting on.
 *
 * `close` now reaches the runtime's own teardown — MCP sessions, and vendor
 * process trees an external-agent session owns — so it can reject. Every site
 * that drops the returned promise has to say so here instead: an unhandled
 * rejection from a superseded connection would take the hub process down.
 */
function closeDetached(
  connection: ManagedRuntimeConnection,
  reason?: RuntimeConnectionCloseReason
): void {
  void Promise.resolve(connection.close(reason)).catch((error: unknown) => {
    console.warn(
      '[runtime] Releasing a runtime connection failed:',
      error instanceof Error ? error.message : 'unknown error'
    );
  });
}

export type RuntimeEnvironmentResolver = (
  userId: string,
  environmentId: string
) => Promise<RuntimeEnvironmentDefinition | null>;

/**
 * A step long enough that the card has to name it, rather than showing
 * `connecting` for minutes and reading as a hub that has stopped answering.
 * Only container launches raise one so far — a cold image pull.
 */
export type RuntimeConnectPhase = 'pulling';

export type RuntimeEnvironmentConnector = (
  definition: RuntimeEnvironmentDefinition,
  onUnavailable: () => void,
  report: (phase: RuntimeConnectPhase) => void
) => Promise<ManagedRuntimeConnection>;

export interface RuntimeConnectionManagerOptions {
  readonly resolveEnvironment: RuntimeEnvironmentResolver;
  readonly connectors: Partial<Record<EnvironmentTransportKind, RuntimeEnvironmentConnector>>;
  readonly publish?: (userId: string) => void;
}

/**
 * Told when a peer that used to consent to external agents no longer does.
 *
 * The runtime closes its own sessions when its consent poll turns the capability
 * off, but that close emits no event and does not drop the socket, so nothing
 * else here would tell the hub that the vendor sessions it believes it owns are
 * gone. Registered rather than imported: the session manager lives in a module
 * that already depends on this file.
 */
export type ExternalAgentsRevokedObserver = (userId: string, environmentId: string) => void;

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
  /** Epoch ms the cached manifest was last read from the peer. */
  manifestReadAtMs?: number;
  /** In-flight background refresh, so reads coalesce onto one round-trip. */
  manifestRefresh?: Promise<void>;
  /**
   * Full `runtime.health` last read from the peer. Kept across disconnect so a
   * card can still show version/digest/slot after the socket drops.
   */
  health?: RuntimeHealthReport;
  /** Epoch ms {@link health} was last read. */
  healthReadAtMs?: number;
  /**
   * Epoch ms before which a lazy connect fails fast instead of respawning.
   * `Infinity` latches the environment until someone connects it explicitly.
   */
  retryAfterMs: number;
  /** The next transport loss is an intentional binary handoff, not a crash. */
  expectedUpdateDisconnect?: boolean;
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
 * How long the handshake manifest is trusted before an environment read asks
 * the peer again. Consent changes on the machine, not through the hub, so
 * there is nothing to invalidate on — the card would otherwise show the
 * profile the runtime had at connect until someone reconnected it.
 *
 * The refresh is a `runtime.health` round-trip per connected environment, so
 * it runs in the background and off the read path; the window is what keeps a
 * polling card from making one per poll.
 */
const MANIFEST_FRESHNESS_MS = 15_000;

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
 * ssh and container launches both produce one, for the same reason: their
 * clients report several unrelated causes — an unverified host key, a refused
 * credential, a daemon nobody started, an image that does not exist — through
 * one exit status that `errorCode` cannot distinguish, and each needs a
 * different fix. Validated rather than trusted: the values come back through an
 * untyped details bag.
 */
function failureDetail(
  error: unknown
): Pick<EnvironmentConnectionStatus, 'sshFailureReason' | 'containerFailureReason'> {
  const details = error instanceof RuntimeRemoteError ? error.details : undefined;
  const ssh = details?.sshFailureReason;
  const container = details?.containerFailureReason;
  return {
    ...(Value.Check(SshFailureReasonSchema, ssh) ? { sshFailureReason: ssh } : {}),
    ...(Value.Check(ContainerFailureReasonSchema, container)
      ? { containerFailureReason: container }
      : {}),
  };
}

export class RuntimeConnectionManager {
  readonly #connectors: RuntimeConnectionManagerOptions['connectors'];
  readonly #entries = new Map<string, RuntimeConnectionEntry>();
  readonly #publish: (userId: string) => void;
  readonly #resolveEnvironment: RuntimeEnvironmentResolver;
  #externalAgentsRevoked: ExternalAgentsRevokedObserver | undefined;

  constructor(options: RuntimeConnectionManagerOptions) {
    this.#connectors = options.connectors;
    this.#publish = options.publish ?? (() => undefined);
    this.#resolveEnvironment = options.resolveEnvironment;
  }

  /** Replaces any previous observer; the hub registers one at startup. */
  onExternalAgentsRevoked(observer: ExternalAgentsRevokedObserver | undefined): void {
    this.#externalAgentsRevoked = observer;
  }

  getStatus(userId: string, environmentId: string): EnvironmentConnectionStatus {
    return (
      this.#entries.get(connectionKey(userId, environmentId))?.status ?? {
        state: 'disconnected',
      }
    );
  }

  /**
   * Last full `runtime.health` for this environment, including after disconnect.
   * Absent until {@link refreshManifest} (or an explicit health read) has run.
   */
  getCachedHealth(userId: string, environmentId: string): CachedRuntimeHealth | null {
    const entry = this.#entries.get(connectionKey(userId, environmentId));
    if (!entry?.health || entry.healthReadAtMs === undefined) return null;
    return { health: entry.health, readAtMs: entry.healthReadAtMs };
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
        return this.#openConnection(
          definition,
          () => {
            this.#markUnavailable(key, userId, revision);
          },
          (phase) => {
            this.#reportPhase(entry, userId, revision, phase);
          }
        );
      })
      .then((connection) => {
        if (entry.revision !== revision) {
          closeDetached(connection);
          throw unavailable('Runtime connection was closed.');
        }
        entry.connection = connection;
        entry.connectedAtMs = Date.now();
        entry.manifestReadAtMs = entry.connectedAtMs;
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
    if (superseded) closeDetached(superseded, 'superseded');
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
      closeDetached(connection, 'superseded');
      throw unavailable('Runtime connection was superseded while it was handshaking.');
    }

    entry.connection = connection;
    entry.connectedAtMs = Date.now();
    entry.manifestReadAtMs = entry.connectedAtMs;
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

  /** Releases a connection only when it is still the one the caller observed. */
  disconnectIfCurrent(
    userId: string,
    environmentId: string,
    expectedClient: RuntimeClient
  ): boolean {
    const entry = this.#entries.get(connectionKey(userId, environmentId));
    if (!entry?.connection || entry.connection.client !== expectedClient) return false;

    this.#release(entry);
    this.#publish(userId);
    return true;
  }

  /**
   * Marks the coming transport loss as a binary handoff rather than a crash,
   * and says so on the status so the card reads "updating" through the gap.
   */
  expectUpdateDisconnect(userId: string, environmentId: string): void {
    const entry = this.#entries.get(connectionKey(userId, environmentId));
    if (!entry) return;
    entry.expectedUpdateDisconnect = true;
    entry.status = { ...entry.status, updating: true };
    this.#publish(userId);
  }

  clearExpectedUpdateDisconnect(userId: string, environmentId: string): void {
    const entry = this.#entries.get(connectionKey(userId, environmentId));
    if (!entry) return;
    entry.expectedUpdateDisconnect = false;
    const { updating: _dropped, ...status } = entry.status;
    entry.status = status;
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
    entry.expectedUpdateDisconnect = false;
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

  /**
   * Drops cached peer identity (health, manifest, runtime version) for this
   * user/environment. Disconnect keeps those fields for transient drops; call
   * this when the environment's transport config changes so the card cannot
   * show the previous host.
   */
  clearHealth(userId: string, environmentId: string): void {
    const entry = this.#entries.get(connectionKey(userId, environmentId));
    if (!entry) return;
    const hadPeer =
      entry.health !== undefined ||
      entry.healthReadAtMs !== undefined ||
      entry.status.manifest !== undefined ||
      entry.status.runtimeVersion !== undefined;
    if (!hadPeer) return;
    entry.health = undefined;
    entry.healthReadAtMs = undefined;
    entry.status = {
      state: entry.status.state === 'connected' ? 'disconnected' : entry.status.state,
      ...(entry.status.errorCode ? { errorCode: entry.status.errorCode } : {}),
      ...(entry.status.sshFailureReason ? { sshFailureReason: entry.status.sshFailureReason } : {}),
    };
  }

  /**
   * Names what a still-connecting environment is waiting on.
   *
   * Only applied while this attempt is still the current one — a superseded
   * connect must not repaint a status the next one already owns. Nothing clears
   * the flag: every path out of `connect()` replaces the status wholesale, so
   * it lives exactly as long as the attempt that set it.
   */
  #reportPhase(
    entry: RuntimeConnectionEntry,
    userId: string,
    revision: number,
    phase: RuntimeConnectPhase
  ): void {
    if (entry.revision !== revision || entry.status.state !== 'connecting') return;
    if (phase === 'pulling' && entry.status.pullingImage) return;

    entry.status = { ...entry.status, pullingImage: true };
    this.#publish(userId);
  }

  async #openConnection(
    definition: RuntimeEnvironmentDefinition,
    onUnavailable: () => void,
    report: (phase: RuntimeConnectPhase) => void
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
    return await connector(definition, onUnavailable, report);
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
    closeDetached(entry.connection);
    entry.connection = undefined;
    if (entry.expectedUpdateDisconnect) {
      entry.expectedUpdateDisconnect = false;
      entry.connectedAtMs = undefined;
      entry.failureCount = 0;
      entry.retryAfterMs = 0;
      // `updating` outlives the flag on purpose: the flag exists to classify
      // this one loss, the field to keep the card honest across the whole gap
      // until the restarted runtime hands over a fresh connected status.
      entry.status = {
        state: 'disconnected',
        updating: true,
        ...this.#cachedPeer(entry),
      };
      this.#publish(userId);
      return;
    }
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
   * Re-reads `runtime.health` on a live connection, replaces the cached
   * handshake manifest, and publishes so environment cards refresh. Consent
   * changes mid-connection are invisible to the cosmetic filter until this
   * runs; the runtime still refuses correctly in the meantime.
   */
  async refreshManifest(
    userId: string,
    environmentId: string
  ): Promise<EnvironmentConnectionStatus> {
    const key = connectionKey(userId, environmentId);
    const entry = this.#entries.get(key);
    const client = entry?.connection?.client;
    if (!client || entry?.status.state !== 'connected') {
      return this.getStatus(userId, environmentId);
    }
    const revision = entry.revision;
    // Stamped before the round-trip, not after: a peer that is slow or failing
    // to answer must not be asked again by every read that arrives meanwhile.
    entry.manifestReadAtMs = Date.now();

    const health = await client.health();
    if (
      entry.revision !== revision ||
      entry.connection?.client !== client ||
      entry.status.state !== 'connected'
    ) {
      return this.getStatus(userId, environmentId);
    }
    entry.health = health;
    entry.healthReadAtMs = entry.manifestReadAtMs;
    const manifest = capabilityManifestFromHealth(health);
    client.replaceManifest(manifest);
    const changed = !Value.Equal(entry.status.manifest, manifest);
    // A peer that withdrew this consent has already closed its vendor sessions,
    // silently. Reported before the status is replaced, so the comparison is
    // against what the hub last believed rather than what it is about to store.
    const externalAgentsRevoked =
      entry.status.manifest?.features.externalAgents === true &&
      manifest.features.externalAgents !== true;
    entry.status = {
      ...entry.status,
      state: 'connected',
      manifest,
      ...peerRelease(client.runtimeVersion),
    };
    if (externalAgentsRevoked) this.#externalAgentsRevoked?.(userId, environmentId);
    // Only a real change publishes. The environment read that triggers the
    // background refresh is itself woken by this invalidation, so publishing
    // an identical manifest would make the card refetch on every window.
    if (changed) this.#publish(userId);
    return entry.status;
  }

  /**
   * Asks the peer for its manifest again when the cached one has aged past
   * {@link MANIFEST_FRESHNESS_MS}, without making the caller wait for it.
   *
   * Environment reads call this. The read answers from cache, and a consent
   * change that landed on the machine reaches the card through the
   * invalidation {@link refreshManifest} publishes when the answer differs.
   * A refusal is authoritative at the runtime either way; this is what keeps
   * the hub's cosmetic view from contradicting it.
   */
  refreshManifestIfStale(userId: string, environmentId: string): void {
    const entry = this.#entries.get(connectionKey(userId, environmentId));
    if (entry?.status.state !== 'connected' || entry.manifestRefresh) return;
    if (Date.now() - (entry.manifestReadAtMs ?? 0) < MANIFEST_FRESHNESS_MS) return;

    entry.manifestRefresh = this.refreshManifest(userId, environmentId)
      // A peer that cannot answer `runtime.health` is not a reason to fail the
      // environment read; the connection's own failure handling owns that.
      .catch(() => undefined)
      .then(() => {
        entry.manifestRefresh = undefined;
      });
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
      name: LOCAL_ENVIRONMENT_NAME,
      transportKind: 'in-process',
      config: {},
      enabled: true,
    };
  }
  return await environmentRepository.find(userId, environmentId);
}

interface LocalRuntimeOpenOptions {
  readonly onUnavailable: () => void;
  readonly authorizeWorkspace: (
    canonicalPath: string,
    signal: AbortSignal
  ) => boolean | Promise<boolean>;
  readonly identityIsolation?: ExternalIdentityIsolation;
}

async function connectLocalRuntime(
  options: LocalRuntimeOpenOptions
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
    externalAgents: {
      authorizeWorkspace: options.authorizeWorkspace,
      ...(options.identityIsolation ? { identityIsolation: options.identityIsolation } : {}),
    },
    consent: createSlotConsentSource({
      slot: 'host',
      ...(probe && !probe.error ? { initial: probe.config.allow } : {}),
    }),
  });
  const connection: InProcessRuntimeConnection = await connectInProcessRuntime(host, {
    hubVersion: version,
  });
  return {
    client: new RuntimeClient(connection.client, options.onUnavailable),
    close: () => connection.close(),
  };
}

async function isAuthorizedLocalWorkspace(
  definition: RuntimeEnvironmentDefinition,
  canonicalPath: string,
  signal: AbortSignal
): Promise<boolean> {
  if (definition.id !== LOCAL_ENVIRONMENT_ID || !definition.userId) return false;
  signal.throwIfAborted();
  const query = getDb()
    .selectFrom('chats')
    .select('id')
    .where('userId', '=', definition.userId)
    .where('environmentId', '=', definition.id)
    .where('workdir', '=', canonicalPath)
    .limit(1)
    .executeTakeFirst();
  const aborted = Promise.withResolvers<never>();
  const abort = () =>
    aborted.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error('Local workspace authorization was cancelled.')
    );
  signal.addEventListener('abort', abort, { once: true });
  try {
    const chat = await Promise.race([query, aborted.promise]);
    signal.throwIfAborted();
    return chat !== undefined;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export interface LocalRuntimeConnectorOptions {
  readonly open?: (options: LocalRuntimeOpenOptions) => Promise<ManagedRuntimeConnection>;
  readonly isWorkspaceAuthorized?: (
    definition: RuntimeEnvironmentDefinition,
    canonicalPath: string,
    signal: AbortSignal
  ) => boolean | Promise<boolean>;
}

/**
 * Binds the hub process's OS credential home to one MangoStudio user.
 *
 * Separate Local RuntimeHost instances still share the same OS account. The
 * first authenticated owner may be attested while it is the only owner the
 * process has served. If a second owner appears, every attested connection is
 * closed before that owner connects and this connector permanently falls back
 * to unproven isolation. Local filesystem and shell access keep working for
 * both users, but neither can launch a vendor process through shared credentials.
 */
export function createLocalRuntimeConnector(
  options: LocalRuntimeConnectorOptions = {}
): RuntimeEnvironmentConnector {
  const open = options.open ?? connectLocalRuntime;
  const isWorkspaceAuthorized = options.isWorkspaceAuthorized ?? isAuthorizedLocalWorkspace;
  let ownerUserId: string | undefined;
  let multipleOwners = false;
  let connectSerial: Promise<void> = Promise.resolve();
  const active = new Set<{
    readonly connection: ManagedRuntimeConnection;
    readonly identityAttested: boolean;
    readonly onUnavailable: () => void;
  }>();

  return (definition, onUnavailable) => {
    const attempt = connectSerial.then(async () => {
      if (definition.id !== LOCAL_ENVIRONMENT_ID) {
        throw unavailable('Single-user-host attestation is reserved for the Local environment.');
      }
      if (!definition.userId) {
        throw unavailable('The Local runtime requires a bound MangoStudio user.');
      }
      // CLI/setup probes use this documented stand-in when no authenticated user
      // exists. They may inspect Local, but they neither consume nor establish
      // the one real-user binding and therefore receive no identity attestation.
      if (definition.userId === 'local') {
        return await open({
          onUnavailable,
          authorizeWorkspace: (canonicalPath, signal) =>
            isWorkspaceAuthorized(definition, canonicalPath, signal),
        });
      }
      if (ownerUserId !== undefined && ownerUserId !== definition.userId) {
        multipleOwners = true;
      }
      if (multipleOwners) {
        const attested = [...active].filter((entry) => entry.identityAttested);
        const closed = await Promise.allSettled(
          attested.map(async (entry) => {
            try {
              await entry.connection.close('released');
            } finally {
              entry.onUnavailable();
            }
          })
        );
        if (closed.some((result) => result.status === 'rejected')) {
          throw unavailable('Could not revoke Local single-user-host attestation.');
        }
        for (const entry of attested) {
          active.delete(entry);
        }
      }

      const identityIsolation = multipleOwners
        ? undefined
        : createSingleUserHostExternalAgentIsolation();
      const connection = await open({
        onUnavailable,
        authorizeWorkspace: (canonicalPath, signal) =>
          isWorkspaceAuthorized(definition, canonicalPath, signal),
        ...(identityIsolation ? { identityIsolation } : {}),
      });
      // Do not let a failed first handshake reserve the OS credential home.
      // Serialization above makes this the only successful claimant that can
      // observe the binding as empty.
      ownerUserId ??= definition.userId;
      const entry = {
        connection,
        identityAttested: identityIsolation !== undefined,
        onUnavailable,
      };
      active.add(entry);
      return {
        client: connection.client,
        async close(reason) {
          active.delete(entry);
          await connection.close(reason);
        },
      };
    });
    connectSerial = attempt.then(
      () => undefined,
      () => undefined
    );
    return attempt;
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
 *
 * Exported for the same reason `connectSshRuntime` is: so its failure
 * classification is testable directly rather than only through a live
 * `getRuntimeConnectionManager()` singleton.
 */
export async function connectWslRuntime(
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

  const wslExecutable = resolveWslExecutable();
  const connection = await spawnRuntimeChild({
    environmentId: definition.id,
    launch: wslLaunchCommand(distro, wslExecutable.path),
    hubVersion: getVersion(),
    describeFailure: (failure: RuntimeLaunchFailure) =>
      failure.spawnErrorCode === 'ENOENT'
        ? `WSL could not be started at "${wslExecutable.path}". Install WSL, or set MANGO_WSL_EXE to the wsl.exe path if it is installed somewhere else.`
        : undefined,
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
      'in-process': createLocalRuntimeConnector(),
      stdio: connectStdioRuntime,
      wsl: connectWslRuntime,
      websocket: refuseDialInRuntime,
      http: connectHttpRuntime,
      ssh: connectSshRuntime,
      container: connectContainerRuntime,
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
