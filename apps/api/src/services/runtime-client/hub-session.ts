/**
 * Turning any transport port into a runtime the hub can talk to.
 *
 * Everything a connector has to decide before this point is its own — how to
 * reach the machine, what credential to present, when to give up — and
 * everything after it is the same for all of them: exchange hellos, check that
 * what came back is a runtime manifest this build understands, and hand back a
 * request surface. `openHubSession` is that middle.
 *
 * The SDK does not validate `hello.capabilities` — the protocol defines no
 * member of it — so the check that the peer is a MangoStudio runtime, and not
 * merely something that speaks the wire, happens here.
 */

import {
  CLOSE_CODES,
  type EventFrame,
  type Port,
  RESERVED_ERROR_CODES,
  RemoteError,
  type RequestOptions,
  Session,
  type SessionClosure,
} from '@mangostudio/protocol';
import { ExternalAgentEventEnvelopeFrameSchema } from '@mangostudio/shared/external-agents';
import {
  acceptedRuntimeImplementation,
  type HubExternalAgentIsolation,
  type HubIdentity,
  RUNTIME_CONTRACT,
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
  RUNTIME_EXTERNAL_AGENT_TOPIC,
  RUNTIME_TERMINAL_OUTPUT_TOPIC,
  type RuntimeCapabilityManifest,
  RuntimeCapabilityManifestSchema,
  RuntimeImplementationSchema,
  type RuntimeMethod,
  type RuntimeMethodMap,
  RuntimeTerminalOutputEventSchema,
} from '@mangostudio/shared/runtime-contract';
import type { TSchema } from 'typebox';
import Value from 'typebox/value';
import { createDiagnosticLogger } from '../../lib/logger';
import {
  type ContractCheckResult,
  checkAgainstContract,
  schemaByDiscriminant,
} from './contract-schema';
import {
  type ContractViolation,
  describeContractViolation,
  RuntimeContractViolationError,
} from './contract-violation';
import { resolveLocalHubIdentity } from './hub-identity';
import {
  type EnvironmentWorkspacePolicy,
  type HubWorkspaceBinding,
  serveHubContract,
} from './hub-workspace-authority';
import { RuntimeRequestNoReplyError, RuntimeRequestNotSentError } from './request-not-sent';

/** Name this hub announces itself under; the runtime's audit log records it. */
const HUB_PEER_NAME = 'mangostudio';

const logger = createDiagnosticLogger('hub-session');

/** One schema per `terminal.output` frame `kind`, read from the union itself. */
const TERMINAL_OUTPUT_SCHEMA_BY_KIND = schemaByDiscriminant(
  RuntimeTerminalOutputEventSchema,
  'kind'
);

/**
 * Whether a raw event frame reaches this connection's subscribers, and what
 * to log or do about it when it does not.
 */
interface EventFrameOutcome {
  readonly deliver: boolean;
  /** Closes the session instead of merely dropping the frame. */
  readonly fatal: boolean;
  readonly violation?: ContractViolation;
}

const DELIVER: EventFrameOutcome = { deliver: true, fatal: false };

/**
 * Checks one raw event frame against the contract, per topic, and decides
 * what a failure means for it.
 *
 * `external-agent.event` is checked against its envelope only, not the
 * catalog's full payload schema (envelope **and** event): a runtime newer
 * than this hub can emit an event `type` this build's copy of
 * `ExternalAgentEventSchema` has never heard of, and the catalog schema would
 * fail the whole frame for that — indistinguishable from a corrupt one, and
 * dropping either loses a sequence number nothing else will ever cover. See
 * the comment on `ExternalAgentEventEnvelopeFrameSchema` and #964. A broken
 * envelope, unlike an unrecognized `event`, has no sequence number to admit in
 * the first place, so it is fatal. Whether a *known* event type's own shape is
 * malformed is decided downstream, per event, by the consumer that already
 * owns that judgment (`RuntimeClient.externalAgents.onEvent`) — not here, per
 * envelope.
 *
 * `terminal.output` is a union tagged by `kind`, with a fixed set of members
 * today — none of `RUNTIME_CONTRACT`'s standing exceptions to the "written
 * open" rule (see `contract-schema.ts`) touch it, so any future member would
 * be tolerated as written. Only a genuinely forward-compatible frame — an
 * object with a string `kind` this build's union does not name — passes
 * through unvalidated; a payload that is not an object, or has no string
 * `kind` at all, is not a newer peer's extension, it is malformed, and is
 * fatal exactly like a recognized `kind` whose other fields are wrong. The
 * peer's own frame never gets to decide whether it is checked.
 *
 * Every other known topic is a single flat schema with no such split: a
 * violation is logged and the frame is dropped, non-fatally — nothing depends
 * on every `runtime.heartbeat` or `mcp.session` frame arriving.
 *
 * A payload can pass every check above and the frame still be unusable: the
 * catalog marks `terminal.output` and `install.output` as streams — one
 * `streamId` per terminal session or install run — and their consumers
 * (`RuntimeClient.terminal.onOutput`, `install-runner.ts`) filter on it
 * before ever looking at the payload. A schema-valid frame with an absent or
 * non-string `streamId` would pass this boundary and then be silently
 * discarded downstream — lost terminal output or install logs on a
 * connection that never reports anything wrong. So a streamed topic's
 * `streamId` is checked here too, with the same fatal/non-fatal split its
 * payload already gets. `external-agent.event` is also marked `stream: true`
 * in the catalog, but `RuntimeClient.externalAgents.onEvent` addresses by
 * `payload.sessionId`, never `frame.streamId` — so a missing one there causes
 * no downstream harm, and is not checked.
 */
function evaluateEventFrame(frame: EventFrame): EventFrameOutcome {
  if (frame.topic === RUNTIME_EXTERNAL_AGENT_TOPIC) {
    return fromCheck(
      checkAgainstContract(ExternalAgentEventEnvelopeFrameSchema, frame.payload),
      true
    );
  }
  if (frame.topic === RUNTIME_TERMINAL_OUTPUT_TOPIC) {
    if (!hasStreamId(frame))
      return { deliver: false, fatal: true, violation: MISSING_STREAM_ID_VIOLATION };
    return evaluateTerminalOutputFrame(frame.payload);
  }
  const schema = catalogEventPayloadSchema(frame.topic);
  if (!schema) return DELIVER; // topic this build's catalog does not name
  if (isStreamedTopic(frame.topic) && !hasStreamId(frame)) {
    return { deliver: false, fatal: false, violation: MISSING_STREAM_ID_VIOLATION };
  }
  return fromCheck(checkAgainstContract(schema, frame.payload), false);
}

const MISSING_STREAM_ID_VIOLATION: ContractViolation = {
  path: '#/streamId',
  message: 'must be a non-empty string on a streamed topic',
};

function hasStreamId(frame: EventFrame): boolean {
  return typeof frame.streamId === 'string' && frame.streamId.length > 0;
}

function isStreamedTopic(topic: string): boolean {
  const events = (RUNTIME_CONTRACT.definition.events ?? {}) as unknown as Readonly<
    Record<string, { readonly stream?: boolean }>
  >;
  return events[topic]?.stream === true;
}

function fromCheck(result: ContractCheckResult, fatal: boolean): EventFrameOutcome {
  if (result.ok) return DELIVER;
  return { deliver: false, fatal, violation: result.violation };
}

/**
 * `terminal.output`'s frame, split three ways by its `kind`: a recognized
 * `kind` is checked against that one branch; an unrecognized *string* `kind`
 * is a newer runtime's own extension to the union and passes through
 * unvalidated; anything else — not an object, or no string `kind` at all — is
 * malformed, not forward-compatible, and is fatal. Fatal either way once a
 * `kind` fails to name a recognized branch, this reports against the whole
 * union rather than a branch that was never identified.
 */
function evaluateTerminalOutputFrame(payload: unknown): EventFrameOutcome {
  if (typeof payload !== 'object' || payload === null) {
    return fatalViolation(RuntimeTerminalOutputEventSchema, payload);
  }
  const kind = (payload as { kind?: unknown }).kind;
  if (typeof kind !== 'string') return fatalViolation(RuntimeTerminalOutputEventSchema, payload);
  const branch = TERMINAL_OUTPUT_SCHEMA_BY_KIND.get(kind);
  if (!branch) return DELIVER; // a `kind` this build's union does not name
  return fromCheck(checkAgainstContract(branch, payload), true);
}

function fatalViolation(schema: TSchema, value: unknown): EventFrameOutcome {
  return { deliver: false, fatal: true, violation: describeContractViolation(schema, value) };
}

function catalogEventPayloadSchema(topic: string): TSchema | undefined {
  const events: Readonly<Record<string, { readonly payload: TSchema }>> =
    RUNTIME_CONTRACT.definition.events ?? {};
  return events[topic]?.payload;
}

/**
 * A runtime that has finished its handshake, as the hub-side facade sees it.
 *
 * Narrower than the SDK session on purpose: `RuntimeClient` needs a request
 * surface, the two announcement facts and two subscriptions, and nothing else.
 * The closure reaches the listener because why a connection was lost is what a
 * connector logs and an environment card reports.
 */
export interface HubSession {
  /** The hub claim stays with this connection across manifest refreshes. */
  readonly externalAgentIsolation?: HubExternalAgentIsolation;
  /** The validated manifest after applying the hub claim. */
  readonly manifest: RuntimeCapabilityManifest;
  readonly runtimeVersion: string;
  /** The wire minor both ends negotiated in `hello` (spec §5.2). */
  readonly effectiveMinor: number;
  request<K extends RuntimeMethod>(
    method: K,
    params: RuntimeMethodMap[K]['params'],
    options?: RequestOptions
  ): Promise<RuntimeMethodMap[K]['result']>;
  onEvent(listener: (event: EventFrame) => void): () => void;
  onClose(listener: (closure: SessionClosure) => void): () => void;
  close(code?: number, reason?: string): void;
}

/** A {@link HubSession} backed by a real protocol session. */
export interface ProtocolHubSession extends HubSession {
  readonly session: Session;
}

export interface OpenHubSessionOptions {
  /** Release string this hub announces; the runtime records it. */
  readonly hubVersion: string;
  /**
   * Who is speaking for this hub, for the runtime's audit log. Omit it to
   * announce this process's own host and user; pass `null` to announce none.
   */
  readonly hub?: HubIdentity | null;
  /**
   * What this hub can say about who reaches the runtime's machine.
   *
   * Announced rather than injected at construction so every transport carries
   * it — a runtime the hub did not spawn has no argv to receive it on — and so
   * a reconnect re-states it rather than freezing the first answer for the life
   * of a process.
   */
  readonly externalAgentIsolation?: HubExternalAgentIsolation;
  readonly handshakeTimeoutMs?: number;
  /**
   * Refuse a runtime whose release differs from the hub's. Set by the
   * transports where the two ship as one distribution and are meant to travel
   * together, so a leftover binary from an older install is rejected instead of
   * being trusted for method semantics it may no longer share. The wire version
   * alone cannot catch that: it only changes when the frame format does.
   */
  readonly requireMatchingRelease?: boolean;
  /**
   * The user and environment this connection speaks for, from the hub's own
   * record of it. `hub.workspace.authorize` answers for this binding only;
   * `null` is a connection with no real user, and every answer is `false`.
   * Required so every transport states its binding rather than forgetting it.
   */
  readonly workspaceBinding: HubWorkspaceBinding | null;
  /** Replaces the database policy behind `hub.workspace.authorize`; for tests. */
  readonly workspacePolicy?: EnvironmentWorkspacePolicy;
}

/**
 * Handshakes over `port` and returns the runtime behind it.
 *
 * Rejects with a `RemoteError` — `UNAVAILABLE` when the peer never answered or
 * is not a runtime, `PROTOCOL_MISMATCH` when the wire majors or the releases
 * disagree — and closes the port on the way out, so a caller that only sees the
 * rejection leaks nothing.
 *
 * Announces this hub's host and user unless the caller named a `hub` of its
 * own, so every runtime's audit log can attribute what it served.
 *
 * @example
 * const hub = await openHubSession(port, { hubVersion: getVersion(), workspaceBinding: null });
 * const health = await hub.request('runtime.health', {});
 */
export async function openHubSession(
  port: Port,
  options: OpenHubSessionOptions
): Promise<ProtocolHubSession> {
  const hub = options.hub === undefined ? resolveLocalHubIdentity() : options.hub;
  const session = new Session(port, {
    peer: { name: HUB_PEER_NAME, version: options.hubVersion, role: 'hub' },
    capabilities: {
      contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION },
      ...(hub ? { hub } : {}),
      ...(options.externalAgentIsolation
        ? { externalAgentIsolation: options.externalAgentIsolation }
        : {}),
    },
    ...(options.handshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: options.handshakeTimeoutMs }
      : {}),
  });
  // Registered before the handshake settles: the runtime may ask as soon as
  // its first open arrives, and the handler lives as long as the session.
  serveHubContract(session, options.workspaceBinding, options.workspacePolicy);

  let remote: Awaited<Session['ready']>;
  try {
    remote = await session.ready;
  } catch (error) {
    session.close(CLOSE_CODES.RELEASED, 'handshake failed');
    throw error;
  }

  const manifest = manifestOf(remote.capabilities, options.externalAgentIsolation);
  if (!manifest) {
    session.close(CLOSE_CODES.PROTOCOL_ERROR, 'capabilities are not a runtime manifest');
    throw new RemoteError(
      RESERVED_ERROR_CODES.UNAVAILABLE,
      `Peer "${remote.peer.name}" did not announce a runtime capability manifest; expected the members of RuntimeCapabilityManifest in hello.capabilities.`,
      { peer: remote.peer.name }
    );
  }
  if (options.requireMatchingRelease && remote.peer.version !== options.hubVersion) {
    session.close(CLOSE_CODES.FORBIDDEN, 'release mismatch');
    throw new RemoteError(
      RESERVED_ERROR_CODES.PROTOCOL_MISMATCH,
      `Runtime reports version ${remote.peer.version}; this hub is ${options.hubVersion}. A hub-managed runtime must be the same release.`,
      { runtimeVersion: remote.peer.version, hubVersion: options.hubVersion }
    );
  }

  const client = RUNTIME_CONTRACT.client(session);
  const onEvent = attachValidatedEventFanOut(session);
  const onClose = guardedOnClose(session);
  return {
    session,
    manifest,
    runtimeVersion: remote.peer.version,
    effectiveMinor: remote.effectiveMinor,
    ...(options.externalAgentIsolation
      ? { externalAgentIsolation: options.externalAgentIsolation }
      : {}),
    request: (method, params, requestOptions) => {
      // Checked here, synchronously, rather than inferred from the SDK's
      // rejection: once `client.request` is called the SDK's own
      // `UNAVAILABLE` no longer says whether the frame was written.
      if (session.state === 'closed') {
        return Promise.reject(new RuntimeRequestNotSentError(method, session.closure));
      }
      return requestTaggingNoReply(
        session,
        () => requestValidated(client, method, params, requestOptions),
        requestOptions?.timeoutMs
      );
    },
    onEvent,
    onClose,
    close: (code, reason) => session.close(code ?? CLOSE_CODES.RELEASED, reason),
  };
}

/**
 * `client.request` cast to its declared result type without checking it — the
 * SDK validates a server's own result only when `serve` opts into it, and
 * never validates what a client receives. This is that missing check, on the
 * one path every hub-side caller's answer travels.
 *
 * The rejected result never appears in the thrown error: only the method name
 * and the JSON pointer to the first mismatch do.
 */
/**
 * Runs one request and re-raises a failure *this hub* produced — its own
 * deadline, or its own connection closing — as {@link RuntimeRequestNoReplyError}.
 *
 * Everything else is an answer the runtime sent and passes through unchanged.
 * The deadline is recognized by a marker timer armed before the SDK's own, for
 * the same duration: timers of equal delay fire in the order they were set, so
 * by the time the SDK's `TIMEOUT` rejection is handled the marker has fired,
 * and a `TIMEOUT` the runtime sent earlier finds it unfired. A close is
 * recognized by the session being closed when the `UNAVAILABLE` arrives.
 */
async function requestTaggingNoReply<T>(
  session: Session,
  run: () => Promise<T>,
  timeoutMs: number | undefined
): Promise<T> {
  let deadlinePassed = false;
  const marker =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          deadlinePassed = true;
        }, timeoutMs);
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof RemoteError)) throw error;
    if (error.code === RESERVED_ERROR_CODES.TIMEOUT && deadlinePassed) {
      throw new RuntimeRequestNoReplyError(error, 'deadline');
    }
    if (
      error.code === RESERVED_ERROR_CODES.UNAVAILABLE &&
      session.state === 'closed' &&
      error.details?.closeCode !== undefined
    ) {
      throw new RuntimeRequestNoReplyError(error, 'connection-closed');
    }
    throw error;
  } finally {
    if (marker !== undefined) clearTimeout(marker);
  }
}

async function requestValidated<K extends RuntimeMethod>(
  client: ReturnType<typeof RUNTIME_CONTRACT.client>,
  method: K,
  params: RuntimeMethodMap[K]['params'],
  requestOptions?: RequestOptions
): Promise<RuntimeMethodMap[K]['result']> {
  const result = await client.request(method, params, requestOptions);
  const schema = (
    RUNTIME_CONTRACT.definition.methods as Readonly<Record<string, { readonly result: TSchema }>>
  )[method]?.result;
  if (!schema) return result;
  const check = checkAgainstContract(schema, result);
  if (check.ok) return result;
  throw new RuntimeContractViolationError('result', method, check.violation);
}

/**
 * Calls each of `listeners` with `value`, catching and logging any exception
 * so one throwing subscriber cannot stop delivery to the rest of this
 * connection's event subscribers. `onClose` needs the same protection (a
 * fatal contract violation now closes the session to make other code settle
 * in-flight work, so a throwing `onClose` listener would strand it) but
 * cannot share this dispatcher — see {@link guardedOnClose}.
 */
function dispatchGuarded<T>(
  listeners: ReadonlySet<(value: T) => void>,
  value: T,
  logFailure: (message: string) => void
): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch (error) {
      logFailure(error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * Registers `listener` on a single, hub-owned fan-out over the session's raw
 * event stream, built once per session rather than once per subscriber: every
 * frame is checked against the contract exactly once here (see
 * {@link evaluateEventFrame}), however many `onEvent` callers this connection
 * ends up with.
 *
 * @example
 * const onEvent = attachValidatedEventFanOut(session);
 * const off = onEvent((frame) => console.warn(frame.topic));
 */
function attachValidatedEventFanOut(session: Session): HubSession['onEvent'] {
  const listeners = new Set<(event: EventFrame) => void>();
  session.onEvent((frame) => {
    const outcome = evaluateEventFrame(frame);
    if (!outcome.deliver) {
      logger.warn('runtime_event_contract_violation', {
        topic: frame.topic,
        path: outcome.violation?.path,
        reason: outcome.violation?.message,
        fatal: outcome.fatal,
      });
      if (outcome.fatal) {
        session.close(
          CLOSE_CODES.PROTOCOL_ERROR,
          `Event on "${frame.topic}" does not match the contract at ${outcome.violation?.path ?? '#/'}.`
        );
      }
      return;
    }
    dispatchGuarded(listeners, frame, (error) =>
      logger.error('runtime_event_listener_threw', { topic: frame.topic, error })
    );
  });
  // Mirrors the session's own listener set: a connection dropping clears every
  // subscriber on its own, so a caller that forgets to unsubscribe leaks
  // nothing past the socket.
  session.onClose(() => listeners.clear());
  return (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
}

/**
 * `session.onClose`, with a throwing `listener` caught and logged instead of
 * escaping — the same protection {@link attachValidatedEventFanOut} gives
 * event listeners, given to `onClose` one registration at a time rather than
 * through a shared fan-out.
 *
 * One at a time on purpose: `Session.onClose` replays the closure on a
 * microtask to a listener registered *after* the session already closed —
 * `external-session-manager.ts`, `terminal-session-service.ts`,
 * `mcp/runtime-session.ts` and `spawn-runtime-child.ts`'s connection-eviction
 * path all register after an awaited round trip, squarely inside that
 * window. A single fan-out built by calling `session.onClose` once at
 * `openHubSession` time would have registered before the window and dropped
 * every one of those late subscribers' replay.
 *
 * @example
 * const onClose = guardedOnClose(session);
 * const off = onClose((closure) => console.warn(closure.code));
 */
function guardedOnClose(session: Session): HubSession['onClose'] {
  return (listener) =>
    session.onClose((closure) => {
      try {
        listener(closure);
      } catch (error) {
        logger.error('runtime_close_listener_threw', {
          code: closure.code,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
}

/**
 * The peer's `hello.capabilities` as a manifest, or undefined when it is not one.
 *
 * A withdrawal is applied here rather than trusted to the runtime, because the
 * two hellos crossed: a session sends its own from the constructor, so the
 * manifest in front of us was composed before the peer could have read this
 * hub's refusal. The runtime honours it from the next answer onward — this is
 * the one answer it could not.
 */
function manifestOf(
  capabilities: Readonly<Record<string, unknown>>,
  claimed?: HubExternalAgentIsolation
): RuntimeCapabilityManifest | undefined {
  // `contracts` rides in the same open object and is not part of the manifest.
  // Leaving it in would make every `refreshManifest` comparison see a change
  // that never happened and publish an invalidation for nothing.
  // `implementation` is judged on its own: a descriptor this build cannot
  // interpret (a newer schema, a renamed key) must cost the hub that
  // descriptor, never the connection.
  const { contracts: _announced, implementation, ...rest } = capabilities;
  if (!Value.Check(RuntimeCapabilityManifestSchema, rest)) return undefined;
  const accepted = acceptedRuntimeImplementation(implementation);
  if (implementation !== undefined && !accepted) {
    logger.warn('runtime_implementation_ignored', {
      reason: Value.Check(RuntimeImplementationSchema, implementation)
        ? 'unsupported-schema'
        : 'malformed',
    });
  }
  const manifest: RuntimeCapabilityManifest = accepted
    ? { ...rest, implementation: accepted }
    : rest;
  return applyHubIsolationClaim(manifest, claimed);
}

/**
 * Withholds a peer attestation this connection's hub has explicitly refused.
 * Used for the handshake and every replacement, including older peers that
 * repeat their original attestation in health reports.
 *
 * @example
 * const accepted = applyHubIsolationClaim(manifest, 'withdrawn');
 */
export function applyHubIsolationClaim(
  manifest: RuntimeCapabilityManifest,
  claimed?: HubExternalAgentIsolation
): RuntimeCapabilityManifest {
  if (claimed !== 'withdrawn' || manifest.identityIsolation === undefined) return manifest;
  const { identityIsolation: _withdrawn, ...withheld } = manifest;
  return withheld;
}
