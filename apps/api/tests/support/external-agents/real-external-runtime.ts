/**
 * A protocol-backed external-agent runtime, for the one regression that
 * `fake-external-runtime.ts` cannot reproduce.
 *
 * That fake's `emitEnvelope` hands a raw envelope straight to whatever
 * listener `onEvent` stored — it never passes through
 * `RuntimeClient.externalAgents.onEvent`'s own schema filter, because it never
 * builds a `RuntimeClient` at all. A test that only needs ordering, redelivery
 * or disconnect behaviour is right to use that shortcut. A test for #964 is
 * not: the bug **is** that filter dropping an envelope, so proving the fix
 * means going through it. This helper wires a real runtime session to a real
 * `RuntimeClient` over an in-process transport, and exposes just enough of
 * `external-agent.*` to run one turn to completion.
 */

import {
  type ExternalAgentEvent,
  type ExternalAgentOpenParams,
  type ExternalAgentTurnParams,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
import type { RuntimeMethod } from '@mangostudio/shared/runtime-contract';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import { connectTestRuntime, type TestHandler } from '../runtime-fixture';

export interface RealExternalRuntime {
  readonly client: RuntimeClient;
  readonly calls: {
    readonly open: ExternalAgentOpenParams[];
    readonly turn: ExternalAgentTurnParams[];
    readonly cancel: { sessionId: string; nativeTurnId?: string }[];
    readonly close: { sessionId: string }[];
  };
  /** Emits with the next session sequence and the live native turn id. */
  emit(event: ExternalAgentEvent): void;
  /** Publishes a raw frame payload, unchecked — for an envelope the shared schema does not recognize. */
  emitRawFrame(payload: Record<string, unknown>): void;
  /** The sequence the next auto-numbered `emit` will carry. */
  nextSequence(): number;
  sessionId(): string;
  close(): Promise<void>;
}

export async function createRealExternalRuntime(
  options: { readonly nativeTurnId?: string } = {}
): Promise<RealExternalRuntime> {
  const calls: RealExternalRuntime['calls'] = { open: [], turn: [], cancel: [], close: [] };
  const nativeTurnId = options.nativeTurnId ?? 'native-turn-1';
  let openSessionId = '';
  let started = false;
  let sequence = 0;

  const handlers: Partial<Record<RuntimeMethod, TestHandler>> = {
    'external-agent.open': (params) => {
      const typed = params as ExternalAgentOpenParams;
      calls.open.push(typed);
      openSessionId = typed.sessionId;
      return {
        nativeSessionId: 'native-session-1',
        resumed: false,
        effectiveConfiguration: typed.configuration,
        capabilities: {
          ...NO_EXTERNAL_AGENT_CAPABILITIES,
          structuredStreaming: true,
          interactiveApprovals: true,
          cancellation: true,
          resume: true,
        },
      };
    },
    'external-agent.turn': (params) => {
      calls.turn.push(params as ExternalAgentTurnParams);
      started = true;
      return { nativeTurnId };
    },
    'external-agent.cancel': (params) => {
      calls.cancel.push(params as { sessionId: string; nativeTurnId?: string });
      return { ok: true as const };
    },
    'external-agent.close': (params) => {
      calls.close.push(params as { sessionId: string });
      return { ok: true as const };
    },
  };

  const runtime = await connectTestRuntime({ handlers });

  return {
    client: runtime.client,
    calls,
    emit(event) {
      sequence += 1;
      runtime.emit({
        topic: 'external-agent.event',
        streamId: openSessionId,
        payload: {
          sessionId: openSessionId,
          ...(started ? { nativeTurnId } : {}),
          sequence,
          emittedAtMs: sequence,
          event,
        },
      });
    },
    emitRawFrame(payload) {
      const carriedSequence = payload.sequence;
      sequence = Math.max(sequence, typeof carriedSequence === 'number' ? carriedSequence : 0);
      runtime.emit({ topic: 'external-agent.event', streamId: openSessionId, payload });
    },
    nextSequence() {
      return sequence + 1;
    },
    sessionId() {
      return openSessionId;
    },
    async close() {
      await runtime.close();
    },
  };
}
