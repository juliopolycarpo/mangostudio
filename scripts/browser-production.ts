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
  execute: typeof runCommand = runCommand,
  reuseFrontend = false,
  frontendBunRevision?: string
): Promise<RunResult[]> {
  if (reuseFrontend && !/^[a-f0-9]{40}$/.test(frontendBunRevision ?? '')) {
    throw new Error('production frontend: expected explicit 40-character producer Bun revision');
  }
  const build = await execute(
    reuseFrontend ? 'production:verify-frontend' : 'production:build',
    reuseFrontend
      ? [
          'bun',
          './scripts/ci/frontend-artifact.ts',
          'verify',
          '--bun-revision',
          frontendBunRevision ?? '',
        ]
      : ['bun', 'run', '--filter', '@mangostudio/frontend', 'build'],
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
  const args = process.argv.slice(2);
  const revisionIndex = args.indexOf('--frontend-bun-revision');
  const revision = revisionIndex >= 0 ? args[revisionIndex + 1] : undefined;
  if (revisionIndex >= 0) args.splice(revisionIndex, 2);
  exitWithResults(
    await runProductionBrowserSmoke(
      args.filter((arg) => arg !== '--reuse-frontend'),
      runCommand,
      args.includes('--reuse-frontend'),
      revision
    )
  );
}
