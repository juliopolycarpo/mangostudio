/**
 * The runtime that runs inside the hub process, reached the same way as one on
 * another machine.
 *
 * Local could call the handlers directly. It does not, deliberately: a value a
 * remote transport would lose — a `Date`, a `Map`, a `Buffer` that only survives
 * as long as nobody encodes it — would work here and fail everywhere else, and
 * the bug would surface on somebody's workstation rather than in this process.
 * So the frames go through the real codec, and `validateInProcessFrames` says
 * whether they are re-encoded on every hop.
 *
 * It lives on the hub side because the runtime workspace cannot depend on the
 * api workspace, and the hub half of the pair is a hub concern.
 */

import { createInProcessPortPair } from '@mangostudio/protocol/in-process';
import {
  createRuntimeSession,
  loadRuntimeConfig,
  type RuntimeHostDefinition,
  whenRuntimeReleased,
} from '@mangostudio/runtime';
import { type HubSession, openHubSession } from './hub-session';

export interface InProcessRuntimeConnection {
  readonly hub: HubSession;
  close(): Promise<void>;
}

export interface ConnectInProcessRuntimeOptions {
  readonly hubVersion: string;
  /** Defaults to the runtime host's own configuration. */
  readonly validateFrames?: boolean;
  readonly handshakeTimeoutMs?: number;
}

/**
 * Connects the hub and an embedded runtime definition through the real frame path.
 *
 * @example
 * const connection = await connectInProcessRuntime(createLocalRuntimeHost({ runtimeVersion }), {
 *   hubVersion: getVersion(),
 * });
 * const health = await connection.hub.request('runtime.health', {});
 */
export async function connectInProcessRuntime(
  definition: RuntimeHostDefinition,
  options: ConnectInProcessRuntimeOptions
): Promise<InProcessRuntimeConnection> {
  const validateFrames = options.validateFrames ?? loadRuntimeConfig().validateInProcessFrames;
  const ports = createInProcessPortPair({ validateFrames });
  const runtime = createRuntimeSession(ports.b, definition);

  let hub: HubSession;
  try {
    hub = await openHubSession(ports.a, {
      hubVersion: options.hubVersion,
      ...(options.handshakeTimeoutMs !== undefined
        ? { handshakeTimeoutMs: options.handshakeTimeoutMs }
        : {}),
    });
  } catch (error) {
    // The caller only ever sees the rejection, so it cannot reach the handle to
    // release these; a failed handshake would otherwise leak a runtime session.
    runtime.close();
    throw error;
  }

  return {
    hub,
    async close() {
      hub.close();
      runtime.close();
      // Not just "the transport ended": the caller is entitled to know the
      // services this runtime held open — MCP sessions, terminals, spawned
      // vendor processes — are reaped before it moves on.
      await whenRuntimeReleased(runtime);
    },
  };
}
