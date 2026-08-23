import { ROOT_DIR, WORKSPACES, type WorkspaceName } from './config';

// The API serves the frontend directly in dev: `apps/api/src/dev.ts` builds
// `apps/frontend/dist` with `Bun.build()` and Elysia serves it from disk (there
// is no HTML-bundle route — Bun's HTML loader drops a transitive import from
// this graph). So the frontend workspace has no dev server of its own.
export const DEV_WORKSPACES: WorkspaceName[] = ['api'];

export interface DevSelection {
  runnableWorkspaces: WorkspaceName[];
  skippedWorkspaces: WorkspaceName[];
}

export type TurboDevUi = 'stream' | 'tui';

/**
 * Select only workspaces that expose a dev server, redirecting an explicit
 * `--frontend` request to `api` instead of dropping it — the API serves the
 * frontend now, so `--frontend` alone would otherwise start nothing.
 * // Usage: selectDevWorkspaces(['frontend']);
 */
export function selectDevWorkspaces(workspaces: WorkspaceName[]): DevSelection {
  const normalized = dedupe(
    workspaces.map((workspace) => (workspace === 'frontend' ? 'api' : workspace))
  );

  return {
    runnableWorkspaces: normalized.filter(isDevWorkspace),
    skippedWorkspaces: normalized.filter((workspace) => !isDevWorkspace(workspace)),
  };
}

function dedupe(workspaces: WorkspaceName[]): WorkspaceName[] {
  return [...new Set(workspaces)];
}

/** Build a filtered Turbo dev command. // Usage: createTurboDevCommand(['api'], 'stream'); */
export function createTurboDevCommand(workspaces: WorkspaceName[], ui: TurboDevUi): string[] {
  const filters = workspaces.map((workspace) => `--filter=${WORKSPACES[workspace].packageName}`);
  // Loose env mode so the uncached dev servers inherit the full ambient
  // environment (e.g. BETTER_AUTH_SECRET, provider keys). Turbo 2.x defaults to
  // strict mode, which would otherwise strip vars the servers read at startup.
  return ['turbo', 'run', 'dev', `--ui=${ui}`, '--env-mode=loose', ...filters];
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
