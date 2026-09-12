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
 * A definition serves exactly one session. `serve.ts` builds a host per hub
 * connection and `connect.ts` builds one per dial, so a reconnect arrives at a
 * fresh definition rather than rebinding this one — which is what lets a
 * service treat a refused `emit` as final for whatever produced it. The relay
 * exists because the services are built before the session that carries them,
 * not because one definition outlives a connection.
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
import { writeRuntimeDiagnostic } from './diagnostics';
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
 * A host's services are constructed before its session exists: `runtime.ts`
 * creates the relay, hands `emit` to every service, and only then is the
 * definition bound to a port. The relay is what makes that order work.
 *
 * It is not a reconnect mechanism. Nothing rebinds a definition today, and a
 * service that latched on a refusal — install runs, external-agent sessions —
 * would stay mute for its lifetime if anything ever did.
 */
export interface RuntimeEventRelay {
  /**
   * Publishes to the bound session. False when nothing is bound, or the bound
   * session closed, or its handshake has not completed — the three ways a
   * service learns that what it is producing has nowhere to go.
   */
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
  /**
   * Where a teardown failure is reported. Defaults to the runtime's stderr
   * diagnostics, which is where every transport already collects them.
   */
  readonly log?: (message: string) => void;
}

/**
 * Serves one hub over `port` until the transport ends.
 *
 * Handlers are registered inside this call, before the constructor returns, so
 * a request that arrives in the same tick as the handshake still finds them.
 *
 * A teardown that fails once the transport is already gone is reported through
 * `log` rather than swallowed, and never keeps the session from ending.
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

  const released = Promise.withResolvers<void>();
  RELEASED.set(session, released.promise);
  const log = options.log ?? writeRuntimeDiagnostic;
  session.onClose(() => {
    unbind();
    void releaseDefinition(definition, log).then(() => released.resolve());
  });

  return session;
}

/**
 * Drains the audit sink and releases what the handlers held open, reporting
 * whichever step failed.
 *
 * Both steps run whatever the other does, and neither can stop the session
 * ending — the transport is gone by the time this runs, so the operator is the
 * only party left to tell. A vendor process tree that will not reap is exactly
 * the kind of failure that has to reach a log rather than vanish.
 *
 * Only a flush — the sink is process-scoped and shared across every reconnect
 * and supersede that passes through it. The CLI owns `audit.close()` at process
 * end.
 */
async function releaseDefinition(
  definition: RuntimeHostDefinition,
  log: (message: string) => void
): Promise<void> {
  const steps = [
    { label: 'audit flush', run: async () => await definition.audit?.flush() },
    { label: 'host cleanup', run: async () => await definition.onClose() },
  ] as const;
  const outcomes = await Promise.allSettled(steps.map((step) => step.run()));
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === 'fulfilled') continue;
    log(`runtime ${steps[index]?.label} failed: ${asError(outcome.reason).message}`);
  }
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Teardown promises, keyed by the session that owns them.
 *
 * Off the `Session` because it is the SDK's class: a session ends when the
 * transport does, and what the definition still has to release afterwards is
 * this application's business, not the protocol's.
 */
const RELEASED = new WeakMap<Session, Promise<void>>();

/**
 * Settles once `session` has closed *and* its definition finished releasing
 * what the handlers held open — MCP sessions, terminals, spawned vendor
 * processes.
 *
 * `session.onClose` fires as soon as the transport ends, which is earlier: a
 * caller that has to know the child processes are reaped (a test, or a CLI
 * about to drain its audit sink) waits on this instead.
 *
 * @example
 * session.close(CLOSE_CODES.RELEASED);
 * await whenRuntimeReleased(session);
 */
export function whenRuntimeReleased(session: Session): Promise<void> {
  return RELEASED.get(session) ?? Promise.resolve();
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
