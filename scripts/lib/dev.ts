import { ROOT_DIR, WORKSPACES, type WorkspaceName } from './config';

export const DEV_WORKSPACES: WorkspaceName[] = ['api', 'frontend'];

export interface DevSelection {
  runnableWorkspaces: WorkspaceName[];
  skippedWorkspaces: WorkspaceName[];
}

export type TurboDevUi = 'stream' | 'tui';

/** Select only workspaces that expose a dev server. // Usage: selectDevWorkspaces(['api']); */
export function selectDevWorkspaces(workspaces: WorkspaceName[]): DevSelection {
  return {
    runnableWorkspaces: workspaces.filter(isDevWorkspace),
    skippedWorkspaces: workspaces.filter((workspace) => !isDevWorkspace(workspace)),
  };
}

/** Build a filtered Turbo dev command. // Usage: createTurboDevCommand(['api'], 'stream'); */
export function createTurboDevCommand(workspaces: WorkspaceName[], ui: TurboDevUi): string[] {
  const filters = workspaces.map((workspace) => `--filter=${WORKSPACES[workspace].packageName}`);
  return ['turbo', 'run', 'dev', `--ui=${ui}`, ...filters];
}

/** Return the repository root for Turbo dev invocations. // Usage: cwd: getDevCwd(); */
export function getDevCwd(): string {
  return ROOT_DIR;
}

/** Select an interactive UI only outside CI. // Usage: selectTurboDevUi(process.env); */
export function selectTurboDevUi(env: NodeJS.ProcessEnv): TurboDevUi {
  return env.CI ? 'stream' : 'tui';
}

function isDevWorkspace(workspace: WorkspaceName): boolean {
  return DEV_WORKSPACES.includes(workspace);
}
