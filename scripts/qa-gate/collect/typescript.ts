// TypeScript error count per component via tsc --noEmit.

import { runCapture } from './support';

const TS_ERROR_RE = /error TS\d+:/g;
const MAX_STDERR_SHOWN = 300;

type Run = (
  cmd: readonly string[]
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;

/**
 * Number of `error TSxxxx:` diagnostics for the tsconfig under a component root.
 * tsc exits non-zero both when it reports errors and when it dies (OOM, spawn
 * failure, crash); a non-zero exit with no diagnostics is a failure, never zero
 * errors, so it throws with the root, exit code and clipped output.
 * `run` is injected so tests can fake tsc.
 * // Usage: await countTsErrors('apps/api')
 */
export const countTsErrors = async (root: string, run: Run = runCapture): Promise<number> => {
  const { stdout, stderr, exitCode } = await run([
    'bunx',
    'tsc',
    '-p',
    `${root}/tsconfig.json`,
    '--noEmit',
    '--pretty',
    'false',
  ]);
  const errors = (`${stdout}\n${stderr}`.match(TS_ERROR_RE) ?? []).length;
  if (errors === 0 && exitCode !== 0) {
    const shown = `${stderr.trim() || stdout.trim()}`.slice(0, MAX_STDERR_SHOWN);
    throw new Error(`tsc for ${root} exited ${exitCode} with no diagnostics: ${shown}`);
  }
  return errors;
};
