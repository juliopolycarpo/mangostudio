/**
 * A strict external-agent runtime behind a real `RuntimeClient`, for proving
 * how many times the hub actually submits a turn.
 *
 * `fake-external-runtime.ts` hands the hub a hand-built client, so a request
 * error there is whatever the test throws. This one goes through the real
 * protocol session and `openHubSession`, so a closed connection, a timeout and
 * a lost reply reach the hub exactly as they would from a runtime.
 *
 * It behaves like both real runtimes on the one rule that matters here: a
 * repeated `clientMessageId` with byte-identical params is answered from a
 * receipt without a second native submission, the same id with different
 * params is refused, and every receipt is lost when its connection closes.
 * `rpcCount` and `submissionCount` are counted separately, so a
 * reconciliation is two RPCs and one submission.
 */

import { RESERVED_ERROR_CODES, RemoteError } from '@mangostudio/protocol';
import {
  type ExternalAgentEvent,
  type ExternalAgentOpenParams,
  type ExternalAgentTurnParams,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';
import type { RuntimeClient } from '../../../src/services/runtime-client/runtime-client';
import type { RuntimeEnvironmentConnector } from '../../../src/services/runtime-client/runtime-connection-manager';
import { connectTestRuntime, type TestRuntime } from '../runtime-fixture';

/**
 * What the runtime does with the next `external-agent.turn` that is not a
 * receipt hit:
 * - `answer`: submits and replies.
 * - `stall`: submits and never replies (the hub's deadline fires; the
 *   connection stays up).
 * - `drop-ack`: submits, then drops the connection before replying.
 * - `refuse`: replies with an application error and submits nothing.
 * - `refuse-unavailable` / `refuse-timeout`: replies with a reserved
 *   `UNAVAILABLE` or `TIMEOUT` code — a signed-out vendor, a vendor that timed
 *   out — and submits nothing. The reply is receipted like any other, so a
 *   resend gets the same answer, as the Rust runtime does.
 * - `refuse-acceptance-unknown`: replies `details.dispatch: acceptance-unknown`.
 */
type TurnBehaviour =
  | 'answer'
  | 'stall'
  | 'drop-ack'
  | 'refuse'
  | 'refuse-unavailable'
  | 'refuse-timeout'
  | 'refuse-acceptance-unknown';

const REFUSALS: Partial<Record<TurnBehaviour, () => RemoteError>> = {
  refuse: () => new RemoteError('VENDOR_REFUSED', 'The vendor refused this turn.'),
  'refuse-unavailable': () =>
    new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'The vendor CLI is signed out.'),
  'refuse-timeout': () =>
    new RemoteError(RESERVED_ERROR_CODES.TIMEOUT, 'The vendor did not start the turn in time.'),
  'refuse-acceptance-unknown': () =>
    new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'The vendor link dropped mid-submit.', {
      dispatch: 'acceptance-unknown',
    }),
};

export interface ReceiptKeepingRuntime {
  /** Handed to the session manager as `resolveRuntimeClient`; connects when needed. */
  resolveClient(): Promise<RuntimeClient>;
  /** The live client only, never a connect — `resolveExistingRuntimeClient`. */
  existingClient(): Promise<RuntimeClient>;
  /** This runtime as a `RuntimeConnectionManager` connector for the `http` transport. */
  readonly connector: RuntimeEnvironmentConnector;
  /** Every `external-agent.turn` request that reached the runtime, receipt hits included. */
  rpcCount(): number;
  /** Native vendor submissions: one per turn the vendor was actually asked to run. */
  submissionCount(): number;
  /** How many connections `resolveClient` has opened. */
  connectionCount(): number;
  /** How many times the connector was asked to connect, failed attempts included. */
  connectAttemptCount(): number;
  /** Params of every turn request, in arrival order. */
  readonly turns: ExternalAgentTurnParams[];
  /** Every `external-agent.cancel` the hub sent. */
  readonly cancels: { sessionId: string; nativeTurnId?: string }[];
  /** Behaviours for the next submissions, consumed in order; `answer` once empty. */
  readonly script: TurnBehaviour[];
  /** While false, `resolveClient` rejects `UNAVAILABLE` without connecting. */
  setAvailable(available: boolean): void;
  /** Emits on the live connection with the next sequence of the open session. */
  emit(event: ExternalAgentEvent): void;
  /** Resolves every stalled reply as if the lost acknowledgement finally arrived. */
  releaseStalled(): void;
  /** Drops the live connection, losing its receipts. */
  drop(): Promise<void>;
  close(): Promise<void>;
}

interface Connection {
  readonly runtime: TestRuntime;
  readonly receipts: Map<
    string,
    {
      readonly fingerprint: string;
      readonly nativeTurnId?: string;
      readonly refusal?: () => RemoteError;
    }
  >;
  sessionId: string;
  sequence: number;
  nativeTurnId?: string;
}

export function createReceiptKeepingRuntime(): ReceiptKeepingRuntime {
  const turns: ExternalAgentTurnParams[] = [];
  const cancels: ReceiptKeepingRuntime['cancels'] = [];
  const script: TurnBehaviour[] = [];
  const stalled: Array<() => void> = [];
  let rpcs = 0;
  let submissions = 0;
  let connections = 0;
  let connectAttempts = 0;
  let available = true;
  let live: Connection | undefined;

  async function connect(): Promise<Connection> {
    connections += 1;
    const receipts: Connection['receipts'] = new Map();
    const connection: Connection = {
      runtime: undefined as unknown as TestRuntime,
      receipts,
      sessionId: '',
      sequence: 0,
    };
    const runtime = await connectTestRuntime({
      handlers: {
        'external-agent.open': (params) => {
          const typed = params as ExternalAgentOpenParams;
          connection.sessionId = typed.sessionId;
          connection.sequence = 0;
          return {
            nativeSessionId: 'native-session-1',
            resumed: typed.resumeRef !== undefined,
            effectiveConfiguration: typed.configuration,
            capabilities: {
              ...NO_EXTERNAL_AGENT_CAPABILITIES,
              structuredStreaming: true,
              cancellation: true,
              resume: true,
            },
          };
        },
        'external-agent.turn': (params) => {
          const typed = params as ExternalAgentTurnParams;
          rpcs += 1;
          turns.push(typed);
          const fingerprint = JSON.stringify(typed);
          const receipt = receipts.get(typed.clientMessageId);
          if (receipt) {
            if (receipt.fingerprint !== fingerprint) {
              throw new RemoteError(
                RESERVED_ERROR_CODES.INVALID_PARAMS,
                `clientMessageId "${typed.clientMessageId}" was reused with different turn input.`,
                { kind: 'tool_argument' }
              );
            }
            if (receipt.refusal) throw receipt.refusal();
            return { nativeTurnId: receipt.nativeTurnId };
          }
          const behaviour = script.shift() ?? 'answer';
          const refusal = REFUSALS[behaviour];
          if (refusal) {
            receipts.set(typed.clientMessageId, { fingerprint, refusal });
            throw refusal();
          }
          submissions += 1;
          const nativeTurnId = `native-turn-${submissions}`;
          receipts.set(typed.clientMessageId, { fingerprint, nativeTurnId });
          connection.nativeTurnId = nativeTurnId;
          if (behaviour === 'answer') return { nativeTurnId };
          if (behaviour === 'drop-ack') {
            void runtime.close();
            return new Promise(() => undefined);
          }
          return new Promise((resolve) => {
            stalled.push(() => resolve({ nativeTurnId }));
          });
        },
        'external-agent.cancel': (params) => {
          cancels.push(params as { sessionId: string; nativeTurnId?: string });
          return { ok: true as const };
        },
        'external-agent.close': () => ({ ok: true as const }),
      },
    });
    (connection as { runtime: TestRuntime }).runtime = runtime;
    runtime.client.onClose(() => {
      // A reconnect is a new runtime session: every receipt is gone with it.
      receipts.clear();
      if (live === connection) live = undefined;
    });
    live = connection;
    return connection;
  }

  function unavailable(): RemoteError {
    return new RemoteError(
      RESERVED_ERROR_CODES.UNAVAILABLE,
      'Environment "local" is unavailable; expected a reachable runtime.'
    );
  }

  return {
    existingClient() {
      return live ? Promise.resolve(live.runtime.client) : Promise.reject(unavailable());
    },
    connector: async (_definition, onUnavailable) => {
      connectAttempts += 1;
      if (!available) throw unavailable();
      const connection = await connect();
      connection.runtime.client.onClose(() => onUnavailable());
      return {
        client: connection.runtime.client,
        close: () => connection.runtime.close(),
      };
    },
    async resolveClient() {
      if (!available) {
        throw new RemoteError(
          RESERVED_ERROR_CODES.UNAVAILABLE,
          'Environment "local" is unavailable; expected a reachable runtime.'
        );
      }
      return (live ?? (await connect())).runtime.client;
    },
    rpcCount: () => rpcs,
    submissionCount: () => submissions,
    connectionCount: () => connections,
    connectAttemptCount: () => connectAttempts,
    turns,
    cancels,
    script,
    setAvailable(next) {
      available = next;
    },
    emit(event) {
      const connection = live;
      if (!connection) throw new Error('emit needs a live connection; expected one, received none');
      connection.sequence += 1;
      connection.runtime.emit({
        topic: 'external-agent.event',
        streamId: connection.sessionId,
        payload: {
          sessionId: connection.sessionId,
          ...(connection.nativeTurnId ? { nativeTurnId: connection.nativeTurnId } : {}),
          sequence: connection.sequence,
          emittedAtMs: connection.sequence,
          event,
        },
      });
    },
    releaseStalled() {
      for (const resolve of stalled.splice(0)) resolve();
    },
    async drop() {
      await live?.runtime.close();
    },
    async close() {
      await live?.runtime.close();
    },
  };
}
