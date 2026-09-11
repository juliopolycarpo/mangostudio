/**
 * The hub half of a runtime session, without leaving the process.
 *
 * A gate-level call proves what the handlers do; this proves what a hub gets.
 * Frames go through the real codec, so a value that only survives inside one
 * process — a `Date`, a `Map`, a handle — fails here the way it would on a
 * socket rather than passing and failing on somebody's workstation.
 *
 * The hub side of the product lives in the api workspace, which this one may
 * not import, so the few lines that make a hub session live here instead.
 */

import { CLOSE_CODES, type EventFrame, type RequestOptions, Session } from '@mangostudio/protocol';
import { createInProcessPortPair } from '@mangostudio/protocol/in-process';
import {
  type HubIdentity,
  RUNTIME_CONTRACT,
  RUNTIME_CONTRACT_NAME,
  RUNTIME_CONTRACT_VERSION,
  type RuntimeCapabilityManifest,
  RuntimeCapabilityManifestSchema,
  type RuntimeMethod,
  type RuntimeMethodMap,
} from '@mangostudio/shared/runtime-contract';
import Value from 'typebox/value';
import {
  createRuntimeSession,
  type RuntimeHostDefinition,
  whenRuntimeReleased,
} from '../../src/session';

export interface ConnectedRuntime {
  /** The hub-side session, for a test that watches the connection itself. */
  readonly session: Session;
  /** What the runtime announced, checked the way the hub checks it. */
  readonly manifest: RuntimeCapabilityManifest;
  onEvent(listener: (event: EventFrame) => void): () => void;
  request<K extends RuntimeMethod>(
    method: K,
    params: RuntimeMethodMap[K]['params'],
    options?: RequestOptions
  ): Promise<RuntimeMethodMap[K]['result']>;
  /** Closes both ends and waits for the definition to finish releasing. */
  close(): Promise<void>;
}

export interface ConnectRuntimeOptions {
  readonly hubVersion?: string;
  /** Who the hub says it is; omitted means it announces nobody. */
  readonly hub?: HubIdentity;
}

/**
 * Connects a hub session to `definition` through the real frame path.
 *
 * @example
 * const runtime = await connectRuntimeDefinition(createLocalRuntimeHost({ runtimeVersion: '1.0.0' }));
 * await runtime.request('runtime.health', {});
 * await runtime.close();
 */
export async function connectRuntimeDefinition(
  definition: RuntimeHostDefinition,
  options: ConnectRuntimeOptions = {}
): Promise<ConnectedRuntime> {
  const ports = createInProcessPortPair({ validateFrames: true });
  const runtime = createRuntimeSession(ports.b, definition);
  const session = new Session(ports.a, {
    peer: { name: 'mangostudio', version: options.hubVersion ?? 'hub-test', role: 'hub' },
    capabilities: {
      contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION },
      ...(options.hub ? { hub: options.hub } : {}),
    },
  });

  try {
    await session.ready;
  } catch (error) {
    // The caller only ever sees the rejection, so it cannot reach the handles
    // to release them; a failed handshake would otherwise leak both sessions.
    session.close(CLOSE_CODES.RELEASED, 'handshake failed');
    runtime.close(CLOSE_CODES.RELEASED, 'handshake failed');
    throw error;
  }

  const client = RUNTIME_CONTRACT.client(session);
  return {
    session,
    manifest: manifestOf(session.remote.capabilities),
    onEvent: (listener) => session.onEvent(listener),
    request: (method, params, requestOptions) => client.request(method, params, requestOptions),
    async close() {
      session.close(CLOSE_CODES.RELEASED, 'test finished');
      runtime.close(CLOSE_CODES.RELEASED, 'test finished');
      await whenRuntimeReleased(runtime);
    },
  };
}

/** The peer's `hello.capabilities` as a manifest, or a failure naming what arrived. */
function manifestOf(capabilities: Readonly<Record<string, unknown>>): RuntimeCapabilityManifest {
  if (!Value.Check(RuntimeCapabilityManifestSchema, capabilities)) {
    throw new Error(
      `Runtime announced ${JSON.stringify(capabilities)}; expected a RuntimeCapabilityManifest in hello.capabilities.`
    );
  }
  return capabilities;
}
