// Host tools some tests need and a developer machine may lack. A test that
// cannot run without one is skipped locally with the reason on stderr; in CI the
// same absence throws at collection, so a runner image that drops the tool
// fails the lane instead of reporting fewer tests.

/** What the decision reads; injected so tests need neither a real PATH nor CI. */
export interface HostToolProbe {
  readonly which: (tool: string) => string | null;
  readonly ci: boolean;
  readonly platform: NodeJS.Platform;
  readonly warn: (message: string) => void;
}

const HOST: HostToolProbe = {
  which: (tool) => Bun.which(tool),
  ci: Boolean(process.env.CI),
  platform: process.platform,
  warn: (message) => process.stderr.write(`${message}\n`),
};

/**
 * True when `tool` is not on PATH and the tests that need it should be skipped.
 * Throws in CI, where every lane installs it.
 *
 * @example
 * test.skipIf(hostToolMissing('zip', 'archive tests'))('creates a ZIP', () => {});
 */
export function hostToolMissing(
  tool: string,
  neededBy: string,
  probe: HostToolProbe = HOST
): boolean {
  if (probe.which(tool) !== null) return false;
  const message = `host tool (${neededBy}): expected \`${tool}\` on PATH | received: not found`;
  if (probe.ci) throw new Error(`${message}; CI must install it`);
  probe.warn(`${message}; skipping the tests that need it (install \`${tool}\` to run them)`);
  return true;
}

/**
 * True when this host cannot create a ZIP the way `zipCreationCommand` does:
 * the `zip` binary everywhere but Windows, which uses PowerShell instead.
 *
 * @example
 * test.skipIf(zipCreationUnavailable())('writes a flat Windows ZIP', () => {});
 */
export function zipCreationUnavailable(probe: HostToolProbe = HOST): boolean {
  return probe.platform !== 'win32' && hostToolMissing('zip', 'ZIP archive tests', probe);
}
