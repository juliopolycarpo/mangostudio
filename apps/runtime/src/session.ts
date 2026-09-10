/**
 * One connected hub, on any transport.
 *
 * A {@link RuntimeHostDefinition} is what this machine can do — its manifest,
 * its handlers, its consent source, its teardown — and knows nothing about a
 * connection. {@link createRuntimeSession} binds one to a port: it announces
 * the manifest in `hello.capabilities`, registers the contract handlers behind
 * the consent gate, learns who the hub is once both hellos have crossed, and
 * releases the definition's resources when the transport ends.
 *
 * The same definition is bound again on every reconnect, so the events its
 * services emit have to reach whichever session is current — that is what the
 * relay is for. A definition with no session drops its events, which is what
 * the hub would have done with them anyway.
 */

import { type EventInput, type Port, Session } from '@mangostudio/protocol';
import {
  type HubIdentity,
  HubIdentitySchema,
  RUNTIME_CONTRACT,
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
  type RuntimeCapabilityManifest,
} from '@mangostudio/shared/runtime-contract';
import Value from 'typebox/value';
import type { RuntimeAuditSink } from './audit-log';
import { gateHandlers } from './consent-gate';
import type { RuntimeConsentSource } from './consent-source';
import type { RuntimeHandlers } from './handlers';

/** Name this peer announces itself under; the hub's audit log records it. */
const RUNTIME_PEER_NAME = 'mangostudio-runtime';

export interface RuntimeHostDefinition {
  readonly runtimeVersion: string;
  /**
   * Evaluated once per session rather than once per process, so a host built
   * before its consent source was last read announces the newer snapshot. It
   * is a snapshot either way: consent that changes after `hello` is caught by
   * the dispatch gate and by `runtime.health`, not here.
   */
  readonly manifest: () => RuntimeCapabilityManifest;
  readonly handlers: RuntimeHandlers;
  /** Re-read on every call, so a mid-connection `setup` takes effect. */
  readonly consent: RuntimeConsentSource;
  /** True between `runtime.update.begin` and `runtime.update.commit`. */
  readonly isUpdateActive: () => boolean;
  /**
   * Releases whatever the handlers hold open beyond a single request — MCP
   * sessions, terminals, and their child processes. Fired once, when the
   * session ends.
   */
  readonly onClose: () => void | Promise<void>;
  /** Absent means the slot has auditing off (the `host` default). */
  readonly audit?: RuntimeAuditSink;
  /** Points the services' emitter at one session for that session's lifetime. */
  readonly events: RuntimeEventRelay;
}

/**
 * The indirection between services that emit and the session that carries.
 *
 * Services are built once, at host construction, and the connection they
 * publish over is replaced on every reconnect. Handing them the relay rather
 * than a session means a reconnect rebinds one reference instead of rebuilding
 * the service graph.
 */
export interface RuntimeEventRelay {
  /** Publishes to the bound session; false when nothing is bound or it is not ready. */
  emit(event: EventInput): boolean;
  /** Binds a target and returns the function that unbinds it. */
  bind(target: (event: EventInput) => boolean): () => void;
}

/**
 * Creates the relay a host's services publish through.
 *
 * @example
 * const events = createRuntimeEventRelay();
 * const unbind = events.bind((event) => session.emit(event));
 */
export function createRuntimeEventRelay(): RuntimeEventRelay {
  let target: ((event: EventInput) => boolean) | undefined;
  return {
    emit: (event) => target?.(event) ?? false,
    bind: (next) => {
      target = next;
      return () => {
        if (target === next) target = undefined;
      };
    },
  };
}

interface RuntimeSessionOptions {
  readonly handshakeTimeoutMs?: number;
  readonly livenessIntervalMs?: number | false;
}

/**
 * Serves one hub over `port` until the transport ends.
 *
 * Handlers are registered inside this call, before the constructor returns, so
 * a request that arrives in the same tick as the handshake still finds them.
 *
 * @example
 * const session = createRuntimeSession(stdioPort(), definition);
 * session.onClose(({ code }) => process.exit(code === CLOSE_CODES.RELEASED ? 0 : 1));
 */
export function createRuntimeSession(
  port: Port,
  definition: RuntimeHostDefinition,
  options: RuntimeSessionOptions = {}
): Session {
  const session = new Session(port, {
    peer: {
      name: RUNTIME_PEER_NAME,
      version: definition.runtimeVersion,
      role: 'runtime',
    },
    capabilities: {
      ...definition.manifest(),
      contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION },
    },
    ...(options.handshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: options.handshakeTimeoutMs }
      : {}),
    ...(options.livenessIntervalMs !== undefined
      ? { livenessIntervalMs: options.livenessIntervalMs }
      : {}),
  });

  RUNTIME_CONTRACT.serve(
    session,
    gateHandlers(definition.handlers, {
      consent: definition.consent,
      isUpdateActive: definition.isUpdateActive,
      ...(definition.audit ? { audit: definition.audit } : {}),
    })
  );

  const unbind = definition.events.bind((event) => session.emit(event));
  definition.audit?.setHub(null);

  session.ready.then(
    (remote) => definition.audit?.setHub(hubIdentityOf(remote.capabilities)),
    // A handshake that never completes is a closed session, and the close
    // listener below is what releases the definition; there is nothing else to
    // do with the rejection, and leaving it unhandled would surface as one.
    () => undefined
  );

  session.onClose(() => {
    unbind();
    // Flush only — the sink is process-scoped and shared across every
    // reconnect and supersede that passes through it. The CLI owns
    // `audit.close()` at process end.
    void Promise.allSettled([definition.audit?.flush(), definition.onClose()]);
  });

  return session;
}

/**
 * Who the hub said it is, from its `hello.capabilities`.
 *
 * Validated rather than trusted: `capabilities` is an open object the protocol
 * defines no member of, and an audit line that named a host from an
 * unvalidated field would be evidence of nothing.
 */
function hubIdentityOf(capabilities: Readonly<Record<string, unknown>>): HubIdentity | null {
  const hub = capabilities.hub;
  return Value.Check(HubIdentitySchema, hub) ? hub : null;
}
