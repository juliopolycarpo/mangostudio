/**
 * Enforcement of the hub's path policy on the host that owns the filesystem.
 *
 * The hub decides the policy and checks it before it calls, but that check is
 * lexical: it cannot know that a path inside the chat's working directory is a
 * symbolic link out of it, because the link exists here and not there. Every
 * filesystem method therefore re-checks its own targets against the policy the
 * call carried, using the same guard that glob and grep already apply to the
 * candidates they discover.
 */

import { PathAccessError } from '../errors';
import type { RuntimePathFilter, RuntimePathPolicyParams } from '../methods';
import { compileRuntimePathGuard } from './fs-utils';

/** Reused for calls that carry no policy, so the guard compiles to a constant. */
const UNRESTRICTED: RuntimePathFilter = { allowedRoots: [], deniedRoots: [] };

function assertPathsAllowed(policy: RuntimePathFilter | undefined, paths: readonly string[]): void {
  if (!policy) return;

  const allows = compileRuntimePathGuard(policy);
  for (const path of paths) {
    if (allows(path)) continue;
    throw new PathAccessError(
      `Path "${path}" resolves outside the paths this chat may access on this environment.`
    );
  }
}

/** Compiled guard for methods that filter the candidates they walk themselves. */
export function compilePolicyGuard(
  policy: RuntimePathFilter | undefined
): (path: string) => boolean {
  return compileRuntimePathGuard(policy ?? UNRESTRICTED);
}

/**
 * Wraps a filesystem method so its targets are checked before it runs. The
 * paths are declared per method rather than discovered, so a method added later
 * cannot reach the registry without saying which of its arguments are paths.
 * // Usage: readFile: guardPaths((p) => [p.resolvedPath], readRuntimeFile)
 */
export function guardPaths<P extends RuntimePathPolicyParams, A extends unknown[], R>(
  targets: (params: P) => readonly string[],
  execute: (params: P, ...rest: A) => Promise<R>
): (params: P, ...rest: A) => Promise<R> {
  // Async so a refusal rejects rather than throwing before the promise exists:
  // every caller here treats these as promise-returning.
  return async (params, ...rest) => {
    assertPathsAllowed(params.pathPolicy, targets(params));
    return await execute(params, ...rest);
  };
}
