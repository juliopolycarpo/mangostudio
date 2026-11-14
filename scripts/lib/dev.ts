import { type WorkspaceName, WORKSPACES } from './config';

// The API serves the frontend directly in dev: `apps/api/src/dev.ts` builds
// `apps/frontend/dist` with `Bun.build()` and Elysia serves it from disk (there
// is no HTML-bundle route — Bun's HTML loader drops a transitive import from
// this graph). So the frontend workspace has no dev server of its own.
export const DEV_WORKSPACES: WorkspaceName[] = ['api'];

export interface DevSelection {
  runnableWorkspaces: WorkspaceName[];
  skippedWorkspaces: WorkspaceName[];
}

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

/** One dev server the runner starts: its result label, command and working directory. */
export interface DevTask {
  readonly label: string;
  readonly cmd: string[];
  readonly cwd: string;
}

/**
 * Build the command that starts a workspace's `dev` script.
 *
 * It runs from the workspace directory, the cwd Turbo gave the script. `bun run
 * --filter` would add another process and prefix every output line with the
 * package name. The runner starts it with the default `stdin: 'ignore'`, so the
 * dev tree leads its own process group and a SIGINT or SIGTERM to the runner
 * stops all of it. No `env` is passed: the child inherits the ambient
 * environment, as `--env-mode=loose` did.
 *
 * @example
 * createDevTask('api'); // { label: 'api:dev', cmd: ['bun', 'run', 'dev'], cwd: '<root>/apps/api' }
 */
export function createDevTask(workspace: WorkspaceName): DevTask {
  return { label: `${workspace}:dev`, cmd: ['bun', 'run', 'dev'], cwd: WORKSPACES[workspace].path };
}

function isDevWorkspace(workspace: WorkspaceName): boolean {
  return DEV_WORKSPACES.includes(workspace);
}

/** Builds the runtime binary the hub launches for Local in a source checkout. */
export const LOCAL_RUNTIME_BUILD_COMMAND = [
  'cargo',
  'build',
  '-p',
  'mangostudio-runtime',
  // The lockfile CI builds with, so a drifted Cargo.lock fails here too
  // instead of producing a runtime only this machine can build.
  '--locked',
] as const;

/** The rustup one-liner for a machine with no Rust toolchain. */
export const RUSTUP_INSTALL_COMMAND =
  "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh";

/** What `bun run dev` does about the Local runtime binary before starting the hub. */
export type LocalRuntimeBuildPlan =
  | { readonly kind: 'build'; readonly command: readonly string[] }
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'missing-cargo'; readonly message: string };

/**
 * Decides whether the dev loop builds the Local runtime first.
 *
 * The hub has no other runtime, so a dev server without the binary would boot
 * with a Local that cannot connect. Building every time is cheap once cargo's
 * incremental cache is warm, and it is what keeps a pulled Rust change from
 * running against a stale binary. An explicit `MANGOSTUDIO_RUNTIME_BINARY` is
 * a binary someone already chose — CI's prebuilt one, say — so it is not
 * rebuilt. Without cargo there is nothing to build with, and the message names
 * the one-liner that installs it.
 *
 * @example
 * planLocalRuntimeBuild(process.env, Bun.which('cargo') !== null);
 * // → { kind: 'build', command: ['cargo', 'build', '-p', 'mangostudio-runtime', '--locked'] }
 */
export function planLocalRuntimeBuild(
  env: NodeJS.ProcessEnv,
  hasCargo: boolean
): LocalRuntimeBuildPlan {
  const override = env.MANGOSTUDIO_RUNTIME_BINARY?.trim();
  if (override) {
    return { kind: 'skip', reason: `MANGOSTUDIO_RUNTIME_BINARY is set to ${override}` };
  }
  if (!hasCargo) {
    return {
      kind: 'missing-cargo',
      message:
        'cargo was not found, and the hub launches Local as the Rust mangostudio-runtime binary. ' +
        `Install Rust with \`${RUSTUP_INSTALL_COMMAND}\`, open a new shell, and run \`bun run dev\` again.`,
    };
  }
  return { kind: 'build', command: LOCAL_RUNTIME_BUILD_COMMAND };
}
