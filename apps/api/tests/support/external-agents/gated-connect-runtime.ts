/**
 * An external-agent runtime whose reconnect a test holds open, for proving
 * what the hub does with a connection that finishes after a turn ended.
 *
 * The first connect answers at once. Every later connect waits on a gate the
 * test opens with `releaseConnect()`, so a `RuntimeConnectionManager` stays in
 * its `connecting` state — the slow start of a remote or Windows runtime —
 * for exactly as long as the test needs. Vendor-session opens and closes are
 * recorded on the runtime side, so a session the hub opened and then forgot
 * cannot hide behind the hub's own bookkeeping.
 */

import {
  type ExternalAgentOpenParams,
  NO_EXTERNAL_AGENT_CAPABILITIES,
} from '@mangostudio/shared/external-agents';

import type { RuntimeEnvironmentConnector } from '../../../src/services/runtime-client/runtime-connection-manager';
import { connectTestRuntime, type TestRuntime } from '../runtime-fixture';

export interface GatedConnectRuntime {
  /** This runtime as a `RuntimeConnectionManager` connector for the `http` transport. */
  readonly connector: RuntimeEnvironmentConnector;
  /** Session ids of every `external-agent.open` the runtime answered, in order. */
  readonly opened: string[];
  /** Session ids of every `external-agent.close` the runtime received, in order. */
  readonly closed: string[];
  /** Connects that are waiting on the gate. */
  pendingConnectCount(): number;
  /** Lets every waiting (and every later) connect proceed. */
  releaseConnect(): void;
  /** Drops the live connection, as a runtime that went away. */
  drop(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Builds a runtime whose second and later connects wait for `releaseConnect()`.
 *
 * @example
 * const runtime = createGatedConnectRuntime();
 * const manager = new RuntimeConnectionManager({ connectors: { http: runtime.connector }, ... });
 * await runtime.drop();
 * void manager.connect(userId, 'local', { force: true }); // held at the gate
 * runtime.releaseConnect();
 */
export function createGatedConnectRuntime(): GatedConnectRuntime {
  const opened: string[] = [];
  const closed: string[] = [];
  const waiting: Array<() => void> = [];
  let connects = 0;
  let released = false;
  let live: TestRuntime | undefined;

  function gate(): Promise<void> {
    if (released) return Promise.resolve();
    return new Promise((resolve) => waiting.push(resolve));
  }

  async function connect(): Promise<TestRuntime> {
    const runtime = await connectTestRuntime({
      handlers: {
        'external-agent.open': (params) => {
          const typed = params as ExternalAgentOpenParams;
          opened.push(typed.sessionId);
          return {
            nativeSessionId: `native-${typed.sessionId}`,
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
        'external-agent.close': (params) => {
          closed.push((params as { sessionId: string }).sessionId);
          return { ok: true as const };
        },
        'external-agent.cancel': () => ({ ok: true as const }),
      },
    });
    runtime.client.onClose(() => {
      if (live === runtime) live = undefined;
    });
    live = runtime;
    return runtime;
  }

  return {
    connector: async (_definition, onUnavailable) => {
      connects += 1;
      if (connects > 1) await gate();
      const runtime = await connect();
      runtime.client.onClose(() => onUnavailable());
      return { client: runtime.client, close: () => runtime.close() };
    },
    opened,
    closed,
    pendingConnectCount: () => waiting.length,
    releaseConnect() {
      released = true;
      for (const resolve of waiting.splice(0)) resolve();
    },
    async drop() {
      await live?.close();
    },
    async close() {
      await live?.close();
    },
  };
}
