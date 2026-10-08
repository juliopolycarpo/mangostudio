/** Bun carries its CLI orphan policy into child processes through this internal key. */
export const BUN_ORPHAN_POLICY_ENV = 'BUN_FEATURE_FLAG_NO_ORPHANS';

/**
 * Give controlled process fixtures their original child lifetimes and signal
 * handlers. The test worker keeps its active --no-orphans policy; only the
 * named fake receives this explicit child environment. Bun's native spawn can
 * propagate its active policy when the key is absent, so disable it with `0`.
 * Never mutate the worker's environment.
 *
 * @example
 * const probe = await probeRuntimeHandshake({ command, env: fixtureChildEnvironment() });
 */
export function fixtureChildEnvironment(
  ambient: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...ambient, [BUN_ORPHAN_POLICY_ENV]: '0' };
}
