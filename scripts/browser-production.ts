import { ROOT_DIR } from './lib/config';
import { runCommand, type RunResult } from './lib/exec';
import { header } from './lib/log';
import { exitWithResults } from './lib/summary';

/**
 * Build before starting the focused browser lane, retaining the runner's owned cleanup.
 * @example await runProductionBrowserSmoke();
 */
export async function runProductionBrowserSmoke(
  browserArgs: readonly string[] = [],
  execute: typeof runCommand = runCommand
): Promise<RunResult[]> {
  const build = await execute(
    'production:build',
    ['bun', 'run', '--filter', '@mangostudio/frontend', 'build'],
    { cwd: ROOT_DIR }
  );
  if (build.exitCode !== 0) return [build];

  const browser = await execute(
    'production:browser',
    [
      'bunx',
      '--bun',
      '--no-install',
      'playwright',
      'test',
      '--config',
      'playwright.production.config.ts',
      ...browserArgs,
    ],
    { cwd: ROOT_DIR }
  );
  return [build, browser];
}

if (import.meta.main) {
  header('Production browser regressions');
  exitWithResults(await runProductionBrowserSmoke(process.argv.slice(2)));
}
