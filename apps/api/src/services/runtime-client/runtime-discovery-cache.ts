/**
 * The hub's per-environment cache of `runtime.discover`.
 *
 * `hello.capabilities.implementation` carries the feature-group ceiling and a
 * fingerprint of the build's implementation surface; the detailed method list
 * is fetched once per fingerprint and reused. A reconnect that announces a
 * different fingerprint (an upgraded or downgraded runtime) drops the cached
 * surface, so the hub never answers from a build that is no longer there.
 *
 * `rpc.discover` is deliberately not a fallback: it describes the contract,
 * not what a build implements. A peer without `implementation` has no
 * detailed surface to offer, and the answer is `undefined`.
 */

import {
  acceptedRuntimeImplementation,
  type RuntimeCapabilityManifest,
  type RuntimeDiscoverResult,
} from '@mangostudio/shared/runtime-contract';

/**
 * How long one `runtime.discover` may take. The protocol SDK has no default
 * request timeout, and the reader is an HTTP view: a runtime that never
 * answers must cost that view one line, not hang it.
 */
export const RUNTIME_DISCOVER_TIMEOUT_MS = 5_000;

/** The slice of a runtime client this cache reads. */
export interface RuntimeDiscoverySource {
  readonly manifest: RuntimeCapabilityManifest;
  discoverImplementation(options?: { readonly timeoutMs?: number }): Promise<RuntimeDiscoverResult>;
}

export interface RuntimeDiscoveryCacheOptions {
  /** Defaults to {@link RUNTIME_DISCOVER_TIMEOUT_MS}; overridable for tests. */
  readonly timeoutMs?: number;
}

interface CachedDiscovery {
  readonly fingerprint: string;
  /** The connection the fetch was sent over. */
  readonly source: RuntimeDiscoverySource;
  /** The fetch; a rejection is kept, so this connection is not asked again. */
  readonly discovery: Promise<RuntimeDiscoverResult>;
  /** Set once the fetch answered; a settled answer describes the build, not the connection. */
  settled?: RuntimeDiscoverResult;
}

/**
 * Caches one `runtime.discover` answer per environment, keyed by the
 * fingerprint the live connection announced.
 *
 * @example
 * const cache = new RuntimeDiscoveryCache();
 * cache.observe('user:env', client.manifest); // on every (re)connect
 * const surface = await cache.resolve('user:env', client);
 */
export class RuntimeDiscoveryCache {
  readonly #entries = new Map<string, CachedDiscovery>();
  readonly #timeoutMs: number;

  constructor(options: RuntimeDiscoveryCacheOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? RUNTIME_DISCOVER_TIMEOUT_MS;
  }

  /**
   * Records the manifest a connection just announced, dropping a cached
   * surface whose fingerprint no longer matches. Called on every connect.
   *
   * @example
   * cache.observe(`${userId}:${environmentId}`, connection.client.manifest);
   */
  observe(key: string, manifest: RuntimeCapabilityManifest): void {
    const cached = this.#entries.get(key);
    if (!cached) return;
    if (cached.fingerprint === fingerprintOf(manifest)) return;
    this.#entries.delete(key);
  }

  /**
   * Drops whatever is cached for `key`. Called when the environment is
   * disconnected deliberately or its transport changes, so a cache entry
   * never outlives the environment it describes.
   *
   * @example
   * cache.forget(runtimeDiscoveryKey(userId, environmentId));
   */
  forget(key: string): void {
    this.#entries.delete(key);
  }

  /**
   * The detailed implementation surface for `key`: the cached answer when the
   * fingerprint still matches, otherwise a fresh `runtime.discover`.
   * `undefined` for a peer that announced no implementation.
   *
   * Rejects when the peer answers a fingerprint other than the one it
   * announced in hello, when it does not answer within the timeout, or when
   * the call fails; that failure is remembered for this connection. A fetch still in
   * flight is shared only with its own connection: a reconnect with the same
   * fingerprint asks again rather than waiting on a request the old
   * connection may never answer.
   *
   * @example
   * const surface = await cache.resolve(key, client);
   * surface?.methods.includes('git.exec');
   */
  async resolve(
    key: string,
    source: RuntimeDiscoverySource
  ): Promise<RuntimeDiscoverResult | undefined> {
    const fingerprint = fingerprintOf(source.manifest);
    if (fingerprint === undefined) return undefined;

    const cached = this.#entries.get(key);
    if (cached?.fingerprint === fingerprint) {
      if (cached.settled) return cached.settled;
      if (cached.source === source) return await cached.discovery;
    }

    const discovery = fetchDiscovery(source, fingerprint, this.#timeoutMs);
    const entry: CachedDiscovery = { fingerprint, source, discovery };
    this.#entries.set(key, entry);
    // A failure stays cached as this connection's rejected `discovery`: a
    // runtime that cannot answer is asked once per connection, not on every
    // read. A reconnect or `forget` asks again.
    entry.settled = await discovery;
    return entry.settled;
  }
}

/** The fingerprint of a descriptor this hub can interpret, or undefined. */
function fingerprintOf(manifest: RuntimeCapabilityManifest): string | undefined {
  return acceptedRuntimeImplementation(manifest.implementation)?.fingerprint;
}

async function fetchDiscovery(
  source: RuntimeDiscoverySource,
  announced: string,
  timeoutMs: number
): Promise<RuntimeDiscoverResult> {
  const discovery = await source.discoverImplementation({ timeoutMs });
  if (discovery.fingerprint !== announced) {
    throw new Error(
      `runtime.discover answered implementation fingerprint "${discovery.fingerprint}"; expected the fingerprint announced in hello: "${announced}".`
    );
  }
  return discovery;
}

/**
 * The cache key for one user's environment. The connection manager and every
 * reader must agree on it, so neither spells it out.
 *
 * @example
 * runtimeDiscoveryKey('user-1', 'local'); // 'user-1:local'
 */
export function runtimeDiscoveryKey(userId: string, environmentId: string): string {
  return `${userId}:${environmentId}`;
}

/** The hub-wide cache the connection manager invalidates on every connect. */
export const runtimeDiscoveryCache = new RuntimeDiscoveryCache();
