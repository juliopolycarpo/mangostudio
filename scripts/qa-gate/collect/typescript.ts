// TypeScript error count per component via tsc --noEmit.

import { runCapture } from './support';

const TS_ERROR_RE = /error TS\d+:/g;

/**
 * Number of `error TSxxxx:` diagnostics for the tsconfig under a component root.
 * // Usage: await countTsErrors('apps/api')
 */
export const countTsErrors = async (root: string): Promise<number> => {
  const { stdout, stderr } = await runCapture([
    'bunx',
    'tsc',
    '-p',
    `${root}/tsconfig.json`,
    '--noEmit',
    '--pretty',
    'false',
  ]);
  const combined = `${stdout}\n${stderr}`;
  return (combined.match(TS_ERROR_RE) ?? []).length;
};
