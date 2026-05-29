// TypeScript error count per workspace via tsgo --noEmit.

import type { WorkspaceName } from '../../lib/config';
import { runCapture } from './support';

const TS_ERROR_RE = /error TS\d+:/g;

/** Number of `error TSxxxx:` diagnostics for a workspace's tsconfig. */
export const countTsErrors = async (workspace: WorkspaceName): Promise<number> => {
  const cfg = `apps/${workspace}/tsconfig.json`;
  const { stdout, stderr } = await runCapture([
    'bunx',
    'tsgo',
    '-p',
    cfg,
    '--noEmit',
    '--pretty',
    'false',
  ]);
  const combined = `${stdout}\n${stderr}`;
  return (combined.match(TS_ERROR_RE) ?? []).length;
};
