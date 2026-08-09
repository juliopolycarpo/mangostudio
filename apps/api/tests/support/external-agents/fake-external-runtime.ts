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
  ExternalAgentOpenParams,
  ExternalAgentOpenResult,
  ExternalAgentRespondParams,
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
};

export interface FakeExternalRuntimeOptions {
  readonly nativeSessionId?: string;
  readonly nativeTurnId?: string;
  /** Resolves the vendor's `resumeRef` to whether the resume actually worked. */
  readonly resumeSucceeds?: boolean;
  readonly onOpen?: (params: ExternalAgentOpenParams) => void;
  readonly openFailure?: () => Error;
  readonly turnFailure?: () => Error;
}

export interface FakeExternalRuntime {
  readonly client: RuntimeClient;
  readonly calls: {
    readonly open: ExternalAgentOpenParams[];
    readonly turn: ExternalAgentTurnParams[];
    readonly respond: ExternalAgentRespondParams[];
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
          capabilities: FAKE_CAPABILITIES,
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
