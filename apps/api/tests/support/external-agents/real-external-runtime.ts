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
 * means going through it. This helper wires a real `RuntimeHost` to a real
 * `RuntimeClient` over an in-process transport, and exposes just enough of
 * `external-agent.*` to run one turn to completion.
 */

import {
  connectInProcessRuntime,
  RuntimeHost,
  type RuntimeMethodHandler,
} from '@mangostudio/runtime';
import {
  type ExternalAgentEvent,
  type ExternalAgentOpenParams,
  type ExternalAgentTurnParams,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';

const MANIFEST: RuntimeCapabilityManifest = {
  platform: 'test',
  arch: 'test',
  pathStyle: 'posix',
  homeDir: '/test',
  shells: [],
  git: { available: false },
  features: {
    tools: true,
    git: false,
    probing: false,
    mcp: false,
    library: false,
    checkpoints: true,
  },
};

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

  const handlers = new Map<string, RuntimeMethodHandler>([
    [
      'external-agent.open',
      (params) => {
        const typed = params as ExternalAgentOpenParams;
        calls.open.push(typed);
        openSessionId = typed.sessionId;
        return Promise.resolve({
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
        });
      },
    ],
    [
      'external-agent.turn',
      (params) => {
        calls.turn.push(params as ExternalAgentTurnParams);
        started = true;
        return Promise.resolve({ nativeTurnId });
      },
    ],
    [
      'external-agent.cancel',
      (params) => {
        calls.cancel.push(params as { sessionId: string; nativeTurnId?: string });
        return Promise.resolve({ ok: true as const });
      },
    ],
    [
      'external-agent.close',
      (params) => {
        calls.close.push(params as { sessionId: string });
        return Promise.resolve({ ok: true as const });
      },
    ],
  ]);

  const host = new RuntimeHost({ runtimeVersion: 'runtime-test', manifest: MANIFEST, handlers });
  const connection = await connectInProcessRuntime(host, {
    hubVersion: 'hub-test',
    validateFrames: true,
  });
  const client = new RuntimeClient(connection.client);

  return {
    client,
    calls,
    emit(event) {
      sequence += 1;
      host.emit({
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
      host.emit({ topic: 'external-agent.event', streamId: openSessionId, payload });
    },
    nextSequence() {
      return sequence + 1;
    },
    sessionId() {
      return openSessionId;
    },
    async close() {
      await connection.close();
    },
  };
}
