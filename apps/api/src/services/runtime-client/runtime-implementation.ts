/**
 * What an environment's runtime build implements, method by method.
 *
 * Reads the live connection (never opens one) and answers from the
 * fingerprint-keyed {@link RuntimeDiscoveryCache}, so repeated reads cost one
 * `runtime.discover` per build rather than one per call.
 */

import type { RuntimeDiscoverResult } from '@mangostudio/shared/runtime-contract';
import { getExistingRuntimeClient } from './runtime-connection-manager';
import {
  type RuntimeDiscoveryCache,
  type RuntimeDiscoverySource,
  runtimeDiscoveryCache,
  runtimeDiscoveryKey,
} from './runtime-discovery-cache';

export interface RuntimeImplementationDeps {
  readonly getClient: (userId: string, environmentId: string) => Promise<RuntimeDiscoverySource>;
  readonly cache: RuntimeDiscoveryCache;
}

const DEFAULT_DEPS: RuntimeImplementationDeps = {
  getClient: getExistingRuntimeClient,
  cache: runtimeDiscoveryCache,
};

/**
 * The detailed implementation surface of the environment's connected runtime,
 * or `undefined` when that runtime announced no implementation (an older
 * peer). Rejects like `getExistingRuntimeClient` when nothing is connected.
 *
 * @example
 * const surface = await resolveRuntimeImplementation(userId, environmentId);
 * const hasGit = surface?.methods.includes('git.exec') ?? false;
 */
export async function resolveRuntimeImplementation(
  userId: string,
  environmentId: string,
  deps: RuntimeImplementationDeps = DEFAULT_DEPS
): Promise<RuntimeDiscoverResult | undefined> {
  const client = await deps.getClient(userId, environmentId);
  return await deps.cache.resolve(runtimeDiscoveryKey(userId, environmentId), client);
}
