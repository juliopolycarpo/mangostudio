import { WORKSPACE_DPRINT_PATHS, WORKSPACES, type WorkspaceName } from './config';

const TURBO_CHECK_TASKS = ['check:quick', 'typecheck', 'circular'];

/** Build a filtered Turbo validation command. // Usage: createTurboCheckCommand(['api']); */
export function createTurboCheckCommand(workspaces: WorkspaceName[]): string[] {
  const filters = workspaces.map((workspace) => `--filter=${WORKSPACES[workspace].packageName}`);
  return ['turbo', 'run', ...TURBO_CHECK_TASKS, '--ui=stream', ...filters];
}

/** Build a workspace dprint command. // Usage: createWorkspaceDprintCommand('api'); */
export function createWorkspaceDprintCommand(workspace: WorkspaceName): string[] {
  return ['bunx', 'dprint', 'check', ...WORKSPACE_DPRINT_PATHS[workspace]];
}
