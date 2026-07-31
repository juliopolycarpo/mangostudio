import { WORKSPACES, type WorkspaceName } from './config';

const BUILDABLE_WORKSPACES: WorkspaceName[] = ['frontend', 'api', 'runtime'];

export interface BuildSelection {
  runnableWorkspaces: WorkspaceName[];
  skippedWorkspaces: WorkspaceName[];
}

/** Select only workspaces that expose a build entrypoint. // Usage: selectBuildWorkspaces(['api']); */
export function selectBuildWorkspaces(workspaces: WorkspaceName[]): BuildSelection {
  return {
    runnableWorkspaces: workspaces.filter(isBuildWorkspace),
    skippedWorkspaces: workspaces.filter((workspace) => !isBuildWorkspace(workspace)),
  };
}

/** Build a filtered Turbo build command. // Usage: createTurboBuildCommand(['frontend']); */
export function createTurboBuildCommand(workspaces: WorkspaceName[]): string[] {
  const filters = workspaces.map((workspace) => `--filter=${WORKSPACES[workspace].packageName}`);
  return ['turbo', 'run', 'build', ...filters];
}

function isBuildWorkspace(workspace: WorkspaceName): boolean {
  return BUILDABLE_WORKSPACES.includes(workspace);
}
