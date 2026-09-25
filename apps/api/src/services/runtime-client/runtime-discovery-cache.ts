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

import type {
  RuntimeCapabilityManifest,
  RuntimeDiscoverResult,
} from '@mangostudio/shared/runtime-contract';

/** The slice of a runtime client this cache reads. */
export interface RuntimeDiscoverySource {
  readonly manifest: RuntimeCapabilityManifest;
  discoverImplementation(): Promise<RuntimeDiscoverResult>;
}

interface CachedDiscovery {
  readonly fingerprint: string;
  readonly discovery: Promise<RuntimeDiscoverResult>;
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
    if (cached.fingerprint === manifest.implementation?.fingerprint) return;
    this.#entries.delete(key);
  }

  /**
   * The detailed implementation surface for `key`: the cached answer when the
   * fingerprint still matches, otherwise a fresh `runtime.discover`.
   * `undefined` for a peer that announced no implementation.
   *
   * Rejects when the peer answers a fingerprint other than the one it
   * announced in hello, and caches nothing in that case.
   *
   * @example
   * const surface = await cache.resolve(key, client);
   * surface?.methods.includes('git.exec');
   */
  async resolve(
    key: string,
    source: RuntimeDiscoverySource
  ): Promise<RuntimeDiscoverResult | undefined> {
    const fingerprint = source.manifest.implementation?.fingerprint;
    if (fingerprint === undefined) return undefined;

    const cached = this.#entries.get(key);
    if (cached?.fingerprint === fingerprint) return await cached.discovery;

    const discovery = fetchDiscovery(source, fingerprint);
    const entry = { fingerprint, discovery };
    this.#entries.set(key, entry);
    try {
      return await discovery;
    } catch (error) {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
      throw error;
    }
  }
}

async function fetchDiscovery(
  source: RuntimeDiscoverySource,
  announced: string
): Promise<RuntimeDiscoverResult> {
  const discovery = await source.discoverImplementation();
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
