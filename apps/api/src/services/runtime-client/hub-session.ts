/**
 * Turning any transport port into a runtime the hub can talk to.
 *
 * Everything a connector has to decide before this point is its own — how to
 * reach the machine, what credential to present, when to give up — and
 * everything after it is the same for all of them: exchange hellos, check that
 * what came back is a runtime manifest this build understands, and hand back a
 * request surface. `openHubSession` is that middle.
 *
 * The SDK does not validate `hello.capabilities` — the protocol defines no
 * member of it — so the check that the peer is a MangoStudio runtime, and not
 * merely something that speaks the wire, happens here.
 */

import {
  CLOSE_CODES,
  type EventFrame,
  type Port,
  RESERVED_ERROR_CODES,
  RemoteError,
  type RequestOptions,
  Session,
  type SessionClosure,
} from '@mangostudio/protocol';
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
import { resolveLocalHubIdentity } from './hub-identity';

/** Name this hub announces itself under; the runtime's audit log records it. */
const HUB_PEER_NAME = 'mangostudio';

/**
 * A runtime that has finished its handshake, as the hub-side facade sees it.
 *
 * Narrower than the SDK session on purpose: `RuntimeClient` needs a request
 * surface, the two announcement facts and two subscriptions, and nothing else.
 * The closure reaches the listener because why a connection was lost is what a
 * connector logs and an environment card reports.
 */
export interface HubSession {
  /** The manifest the runtime announced, as it arrived. */
  readonly manifest: RuntimeCapabilityManifest;
  readonly runtimeVersion: string;
  request<K extends RuntimeMethod>(
    method: K,
    params: RuntimeMethodMap[K]['params'],
    options?: RequestOptions
  ): Promise<RuntimeMethodMap[K]['result']>;
  onEvent(listener: (event: EventFrame) => void): () => void;
  onClose(listener: (closure: SessionClosure) => void): () => void;
  close(code?: number, reason?: string): void;
}

/** A {@link HubSession} backed by a real protocol session. */
export interface ProtocolHubSession extends HubSession {
  readonly session: Session;
}

export interface OpenHubSessionOptions {
  /** Release string this hub announces; the runtime records it. */
  readonly hubVersion: string;
  /**
   * Who is speaking for this hub, for the runtime's audit log. Omit it to
   * announce this process's own host and user; pass `null` to announce none.
   */
  readonly hub?: HubIdentity | null;
  readonly handshakeTimeoutMs?: number;
  /**
   * Refuse a runtime whose release differs from the hub's. Set by the
   * transports where the two ship as one distribution and are meant to travel
   * together, so a leftover binary from an older install is rejected instead of
   * being trusted for method semantics it may no longer share. The wire version
   * alone cannot catch that: it only changes when the frame format does.
   */
  readonly requireMatchingRelease?: boolean;
}

/**
 * Handshakes over `port` and returns the runtime behind it.
 *
 * Rejects with a `RemoteError` — `UNAVAILABLE` when the peer never answered or
 * is not a runtime, `PROTOCOL_MISMATCH` when the wire majors or the releases
 * disagree — and closes the port on the way out, so a caller that only sees the
 * rejection leaks nothing.
 *
 * Announces this hub's host and user unless the caller named a `hub` of its
 * own, so every runtime's audit log can attribute what it served.
 *
 * @example
 * const hub = await openHubSession(port, { hubVersion: getVersion() });
 * const health = await hub.request('runtime.health', {});
 */
export async function openHubSession(
  port: Port,
  options: OpenHubSessionOptions
): Promise<ProtocolHubSession> {
  const hub = options.hub === undefined ? resolveLocalHubIdentity() : options.hub;
  const session = new Session(port, {
    peer: { name: HUB_PEER_NAME, version: options.hubVersion, role: 'hub' },
    capabilities: {
      contracts: { [RUNTIME_CONTRACT_NAME]: RUNTIME_CONTRACT_VERSION },
      ...(hub ? { hub } : {}),
    },
    ...(options.handshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: options.handshakeTimeoutMs }
      : {}),
  });

  let remote: Awaited<Session['ready']>;
  try {
    remote = await session.ready;
  } catch (error) {
    session.close(CLOSE_CODES.RELEASED, 'handshake failed');
    throw error;
  }

  const manifest = manifestOf(remote.capabilities);
  if (!manifest) {
    session.close(CLOSE_CODES.PROTOCOL_ERROR, 'capabilities are not a runtime manifest');
    throw new RemoteError(
      RESERVED_ERROR_CODES.UNAVAILABLE,
      `Peer "${remote.peer.name}" did not announce a runtime capability manifest; expected the members of RuntimeCapabilityManifest in hello.capabilities.`,
      { peer: remote.peer.name }
    );
  }
  if (options.requireMatchingRelease && remote.peer.version !== options.hubVersion) {
    session.close(CLOSE_CODES.FORBIDDEN, 'release mismatch');
    throw new RemoteError(
      RESERVED_ERROR_CODES.PROTOCOL_MISMATCH,
      `Runtime reports version ${remote.peer.version}; this hub is ${options.hubVersion}. A hub-managed runtime must be the same release.`,
      { runtimeVersion: remote.peer.version, hubVersion: options.hubVersion }
    );
  }

  const client = RUNTIME_CONTRACT.client(session);
  return {
    session,
    manifest,
    runtimeVersion: remote.peer.version,
    request: (method, params, requestOptions) => client.request(method, params, requestOptions),
    onEvent: (listener) => session.onEvent(listener),
    onClose: (listener) => session.onClose(listener),
    close: (code, reason) => session.close(code ?? CLOSE_CODES.RELEASED, reason),
  };
}

/** The peer's `hello.capabilities` as a manifest, or undefined when it is not one. */
function manifestOf(
  capabilities: Readonly<Record<string, unknown>>
): RuntimeCapabilityManifest | undefined {
  if (!Value.Check(RuntimeCapabilityManifestSchema, capabilities)) return undefined;
  // `contracts` rides in the same open object and is not part of the manifest.
  // Leaving it in would make every `refreshManifest` comparison see a change
  // that never happened and publish an invalidation for nothing.
  const { contracts: _announced, ...manifest } = capabilities as RuntimeCapabilityManifest & {
    readonly contracts?: unknown;
  };
  return manifest;
}
