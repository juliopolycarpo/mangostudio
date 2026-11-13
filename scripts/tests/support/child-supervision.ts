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

/**
 * Markers Bun reads to detect a coding agent. With any of them set,
 * `bun test` prints failures only, so a nested run's `(pass)` lines vanish.
 */
export const BUN_AGENT_MARKER_ENV = ['CLAUDECODE', 'REPL_ID', 'AGENT'] as const;

/**
 * Environment for a nested `bun test` whose reporter output a test asserts on:
 * the fixture child environment without the agent markers, so the nested run
 * reports the same lines from a terminal, from CI and from an agent session.
 *
 * @example
 * Bun.spawnSync([process.execPath, 'test', file], { env: nestedBunTestEnvironment() });
 */
export function nestedBunTestEnvironment(
  ambient: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment = fixtureChildEnvironment(ambient);
  for (const marker of BUN_AGENT_MARKER_ENV) delete environment[marker];
  return environment;
}
