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
 *
 * **This is the one file in `apps/api/src` that imports `@mangostudio/runtime`**,
 * and a unit test pins that. Everything the hub needs from the runtime as a
 * *contract* now lives in `@mangostudio/shared`; what is left here is the
 * in-process wiring itself — building a host definition out of the runtime's
 * own constructors and handing it a port — which is the seam that disappears
 * when Local becomes a spawned sibling.
 */

import { createInProcessPortPair } from '@mangostudio/protocol/in-process';
import {
  createLocalRuntimeHost,
  createRuntimeSession,
  createSingleUserHostExternalAgentIsolation,
  createSlotConsentSource,
  loadRuntimeConfig,
  type RuntimeHostDefinition,
  whenRuntimeReleased,
} from '@mangostudio/runtime';
import type { HubExternalAgentIsolation } from '@mangostudio/shared/runtime-contract';
import { probeRuntimeSlots } from '../../cli/runtime-slot-probe';
import { getVersion } from '../../lib/config';
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
  /** Announced in the hub's `hello`; see {@link HubExternalAgentIsolation}. */
  readonly externalAgentIsolation?: HubExternalAgentIsolation;
}

export interface LocalRuntimeConnectOptions {
  readonly authorizeWorkspace: (
    canonicalPath: string,
    signal: AbortSignal
  ) => boolean | Promise<boolean>;
  /**
   * What this hub can say about who reaches this machine. `withdrawn` when a
   * second MangoStudio user has been seen — the fact the runtime cannot
   * observe from inside its own process.
   */
  readonly externalAgentIsolation: HubExternalAgentIsolation;
}

/**
 * Builds the Local host and connects to it.
 *
 * The attestation is derived here rather than injected: this process *is* the
 * single-user host, so it is the only one in a position to fingerprint the
 * credential home it will hand to a vendor CLI. What the hub contributes is
 * the half it alone can see — whether a second MangoStudio user has turned up
 * — and that travels on the wire, where a spawned runtime can read it too.
 *
 * @example
 * const connection = await connectLocalRuntime({
 *   authorizeWorkspace,
 *   externalAgentIsolation: 'single-user',
 * });
 */
export async function connectLocalRuntime(
  options: LocalRuntimeConnectOptions
): Promise<InProcessRuntimeConnection> {
  const runtimeVersion = getVersion();
  // Local runs in this process, but it is still a runtime on somebody's
  // machine: it answers to the `host` slot's consent like every other one. A
  // user who narrows that slot gets a read-only Local, which is the point of
  // being able to narrow it. Absence resolves to full, so the default is
  // unchanged and no install has to have run.
  const probe = (await probeRuntimeSlots()).find((slot) => slot.slot === 'host');
  const identityIsolation = createSingleUserHostExternalAgentIsolation();
  const definition = createLocalRuntimeHost({
    runtimeVersion,
    externalAgents: {
      authorizeWorkspace: options.authorizeWorkspace,
      ...(identityIsolation ? { identityIsolation } : {}),
    },
    consent: createSlotConsentSource({
      slot: 'host',
      ...(probe && !probe.error ? { initial: probe.config.allow } : {}),
    }),
  });
  return await connectInProcessRuntime(definition, {
    hubVersion: runtimeVersion,
    externalAgentIsolation: options.externalAgentIsolation,
  });
}

/**
 * Connects the hub and an embedded runtime definition through the real frame path.
 *
 * @example
 * const connection = await connectInProcessRuntime(definition, {
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
      // The embedded runtime never asks: it authorizes through the callback
      // it was built with, which runs the same shared policy.
      workspaceBinding: null,
      ...(options.handshakeTimeoutMs !== undefined
        ? { handshakeTimeoutMs: options.handshakeTimeoutMs }
        : {}),
      ...(options.externalAgentIsolation !== undefined
        ? { externalAgentIsolation: options.externalAgentIsolation }
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
