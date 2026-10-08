import { WORKSPACE_DPRINT_PATHS, WORKSPACES, type WorkspaceName } from './config';

/**
 * The Turbo task that typechecks a workspace and every workspace it imports,
 * with all of those `tsc` runs started together. `typecheck` alone would check
 * only the filtered workspace (see `turbo.jsonc`).
 */
export const TYPECHECK_TASK = 'typecheck:with-deps';

const TURBO_CHECK_TASKS = ['check:quick', TYPECHECK_TASK, 'circular'];

/** Build a filtered Turbo validation command. // Usage: createTurboCheckCommand(['api']); */
export function createTurboCheckCommand(workspaces: WorkspaceName[]): string[] {
  const filters = workspaces.map((workspace) => `--filter=${WORKSPACES[workspace].packageName}`);
  return ['turbo', 'run', ...TURBO_CHECK_TASKS, '--ui=stream', ...filters];
}

/** Build a workspace dprint command. // Usage: createWorkspaceDprintCommand('api'); */
export function createWorkspaceDprintCommand(workspace: WorkspaceName): string[] {
  return ['bunx', 'dprint', 'check', ...WORKSPACE_DPRINT_PATHS[workspace]];
}
