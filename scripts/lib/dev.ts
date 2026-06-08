import { ROOT_DIR, WORKSPACES, type WorkspaceName } from './config';

export const DEV_WORKSPACES: WorkspaceName[] = ['api', 'frontend'];

export interface DevSelection {
  runnableWorkspaces: WorkspaceName[];
  skippedWorkspaces: WorkspaceName[];
}

/** Select only workspaces that expose a dev server. // Usage: selectDevWorkspaces(['api']); */
export function selectDevWorkspaces(workspaces: WorkspaceName[]): DevSelection {
  return {
    runnableWorkspaces: workspaces.filter(isDevWorkspace),
    skippedWorkspaces: workspaces.filter((workspace) => !isDevWorkspace(workspace)),
  };
}

/** Build a filtered Turbo dev command. // Usage: createTurboDevCommand(['api']); */
export function createTurboDevCommand(workspaces: WorkspaceName[]): string[] {
  const filters = workspaces.map((workspace) => `--filter=${WORKSPACES[workspace].packageName}`);
  return ['turbo', 'run', 'dev', ...filters];
}

/** Return the repository root for Turbo dev invocations. // Usage: cwd: getDevCwd(); */
export function getDevCwd(): string {
  return ROOT_DIR;
}

function isDevWorkspace(workspace: WorkspaceName): boolean {
  return DEV_WORKSPACES.includes(workspace);
}
