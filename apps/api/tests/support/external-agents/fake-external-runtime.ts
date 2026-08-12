/**
 * A runtime client that hosts a scriptable external agent.
 *
 * It stands in for the runtime's fake adapter on the hub's side of the wire, so
 * the turn controller's ordering, persistence and recovery behaviour can be
 * driven exactly — including the cases a real vendor only produces under load:
 * a redelivered event, a skipped sequence, a stream that keeps talking after it
 * said it was done, and a socket that drops mid-turn.
 */

import type {
  ExternalAgentCapabilities,
  ExternalAgentEvent,
  ExternalAgentEventEnvelope,
  ExternalAgentListSessionsParams,
  ExternalAgentListSessionsResult,
  ExternalAgentOpenParams,
  ExternalAgentOpenResult,
  ExternalAgentRespondParams,
  ExternalAgentStartReviewParams,
  ExternalAgentSteerParams,
  ExternalAgentSteerResult,
  ExternalAgentTurnParams,
} from '@mangostudio/shared/external-agents';
import { NO_EXTERNAL_AGENT_CAPABILITIES } from '@mangostudio/shared/external-agents';
import type { RuntimeClient } from '../../../src/services/runtime-client';

const FAKE_CAPABILITIES: ExternalAgentCapabilities = {
  ...NO_EXTERNAL_AGENT_CAPABILITIES,
  structuredStreaming: true,
  interactiveApprovals: true,
  cancellation: true,
  resume: true,
  steering: true,
};

export interface FakeExternalRuntimeOptions {
  readonly nativeSessionId?: string;
  readonly nativeTurnId?: string;
  /** Resolves the vendor's `resumeRef` to whether the resume actually worked. */
  readonly resumeSucceeds?: boolean;
  readonly onOpen?: (params: ExternalAgentOpenParams) => void;
  readonly openFailure?: () => Error;
  readonly turnFailure?: () => Error;
  readonly capabilities?: ExternalAgentCapabilities;
  /**
   * Overrides the default `{ accepted: true }` outcome of every `steer` call.
   * A promise lets a test hold the call open to inspect what the controller
   * wrote before the vendor answered.
   */
  readonly steerResult?: (
    params: ExternalAgentSteerParams
  ) => ExternalAgentSteerResult | Promise<ExternalAgentSteerResult>;
  readonly steerFailure?: () => Error;
  /** Answers `external-agent.list-sessions`; absent means the vendor has nothing to list. */
  readonly listSessions?: (
    params: ExternalAgentListSessionsParams
  ) => ExternalAgentListSessionsResult;
  /**
   * What `external-agent.start-review` answers as its thread. Defaults to the
   * session's own, which is what inline delivery returns; anything else is the
   * detached answer the hub must refuse to correlate events against.
   */
  readonly reviewThreadId?: string;
  readonly reviewFailure?: () => Error;
}

export interface FakeExternalRuntime {
  readonly client: RuntimeClient;
  readonly calls: {
    readonly open: ExternalAgentOpenParams[];
    readonly turn: ExternalAgentTurnParams[];
    readonly respond: ExternalAgentRespondParams[];
    readonly steer: ExternalAgentSteerParams[];
    readonly startReview: ExternalAgentStartReviewParams[];
    readonly listSessions: ExternalAgentListSessionsParams[];
    readonly cancel: { sessionId: string; nativeTurnId?: string }[];
    readonly close: { sessionId: string }[];
  };
  /** Emits with the next session sequence and the live native turn id. */
  emit(event: ExternalAgentEvent): void;
  /** Emits verbatim, for redelivery, gaps and events aimed at another turn. */
  emitEnvelope(envelope: ExternalAgentEventEnvelope): void;
  /** The sequence the next auto-numbered emit will carry. */
  nextSequence(): number;
  sessionId(): string;
  /** Drops the transport, as a lost runtime connection does. */
  dropConnection(): void;
}

export function createFakeExternalRuntime(
  options: FakeExternalRuntimeOptions = {}
): FakeExternalRuntime {
  const calls: FakeExternalRuntime['calls'] = {
    open: [],
    turn: [],
    respond: [],
    steer: [],
    startReview: [],
    listSessions: [],
    cancel: [],
    close: [],
  };
  const listeners = new Map<string, Set<(envelope: ExternalAgentEventEnvelope) => void>>();
  const closeListeners = new Set<() => void>();
  const nativeTurnId = options.nativeTurnId ?? 'native-turn-1';
  let openSessionId = '';
  let sequence = 0;
  let started = false;

  function publish(envelope: ExternalAgentEventEnvelope): void {
    for (const listener of listeners.get(envelope.sessionId) ?? []) listener(envelope);
  }

  const client = {
    externalAgents: {
      open(params: ExternalAgentOpenParams): Promise<ExternalAgentOpenResult> {
        calls.open.push(params);
        options.onOpen?.(params);
        const failure = options.openFailure?.();
        if (failure) return Promise.reject(failure);
        openSessionId = params.sessionId;
        return Promise.resolve({
          nativeSessionId: options.nativeSessionId ?? 'native-session-1',
          resumed: params.resumeRef !== undefined && options.resumeSucceeds !== false,
          effectiveConfiguration: params.configuration,
          capabilities: options.capabilities ?? FAKE_CAPABILITIES,
        });
      },
      turn(params: ExternalAgentTurnParams) {
        calls.turn.push(params);
        const failure = options.turnFailure?.();
        if (failure) return Promise.reject(failure);
        started = true;
        return Promise.resolve({ nativeTurnId });
      },
      respond(params: ExternalAgentRespondParams) {
        calls.respond.push(params);
        return Promise.resolve({ ok: true as const });
      },
      async steer(params: ExternalAgentSteerParams) {
        calls.steer.push(params);
        const failure = options.steerFailure?.();
        if (failure) throw failure;
        return (await options.steerResult?.(params)) ?? { accepted: true as const };
      },
      startReview(params: ExternalAgentStartReviewParams) {
        calls.startReview.push(params);
        const failure = options.reviewFailure?.();
        if (failure) return Promise.reject(failure);
        started = true;
        return Promise.resolve({
          nativeTurnId,
          reviewThreadId: options.reviewThreadId ?? options.nativeSessionId ?? 'native-session-1',
        });
      },
      listSessions(params: ExternalAgentListSessionsParams) {
        calls.listSessions.push(params);
        return Promise.resolve(options.listSessions?.(params) ?? { sessions: [] });
      },
      cancel(params: { sessionId: string; nativeTurnId?: string }) {
        calls.cancel.push(params);
        return Promise.resolve({ ok: true as const });
      },
      close(params: { sessionId: string }) {
        calls.close.push(params);
        return Promise.resolve({ ok: true as const });
      },
      onEvent(sessionId: string, listener: (envelope: ExternalAgentEventEnvelope) => void) {
        const existing = listeners.get(sessionId) ?? new Set();
        existing.add(listener);
        listeners.set(sessionId, existing);
        return () => existing.delete(listener);
      },
    },
    // Posix semantics: enough for the hub's own canonicalization to be
    // exercised without standing up a manifest. A Windows target's path style
    // is the runtime client's own concern, covered where `createTargetPaths` is.
    paths: {
      canonical: (path: string) => path.replace(/\/+$/, '') || '/',
    },
    // An attesting runtime, so the isolation gate is *passed* rather than
    // bypassed: the turn tests are about turns, and a fake that attested nothing
    // would make every one of them assert the refusal instead.
    //
    // The fingerprint is unique per fake. The hub's registry withdraws an
    // attestation whenever one credential home turns up under two MangoStudio
    // users, and it is process-scoped — so a shared constant here would have the
    // second test that uses a different user id silently contest the first and
    // fail on a refusal it never asked for.
    manifest: {
      identityIsolation: {
        method: 'single-user-host' as const,
        credentialHomeFingerprint: `sha256:fake-runtime-${crypto.randomUUID()}`,
      },
    },
    onClose(listener: () => void) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  } as unknown as RuntimeClient;

  return {
    client,
    calls,
    emit(event) {
      sequence += 1;
      publish({
        sessionId: openSessionId,
        ...(started ? { nativeTurnId } : {}),
        sequence,
        emittedAtMs: sequence,
        event,
      });
    },
    emitEnvelope(envelope) {
      sequence = Math.max(sequence, envelope.sequence);
      publish(envelope);
    },
    nextSequence() {
      return sequence + 1;
    },
    sessionId() {
      return openSessionId;
    },
    dropConnection() {
      for (const listener of [...closeListeners]) listener();
    },
  };
}
