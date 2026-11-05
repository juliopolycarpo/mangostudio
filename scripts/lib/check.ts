import { type WorkspaceName, WORKSPACES } from './config';

/**
 * The Turbo task that typechecks a workspace and every workspace it imports,
 * with all of those `bun check` runs started together. `typecheck` alone would check
 * only the filtered workspace (see `turbo.jsonc`).
 */
export const TYPECHECK_TASK = 'typecheck:with-deps';

export const TURBO_CHECK_TASKS = ['check:quick', 'check:cycles', TYPECHECK_TASK] as const;

/**
 * Select the supervised protocol companion; CI reports already capture its component typecheck.
 * @example createProtocolCheckCommand(true); // internal companion for canonical CI diagnostics
 */
export function createProtocolCheckCommand(ciReport = false): string[] {
  return ciReport
    ? ['bun', './scripts/protocol/check-ci-report.ts']
    : ['bun', './scripts/protocol/check.ts', '--ts-only'];
}

/** Build a filtered Turbo validation command. // Usage: createTurboCheckCommand(['api']); */
export function createTurboCheckCommand(workspaces: WorkspaceName[], typecheck = true): string[] {
  const filters = workspaces.map((workspace) => `--filter=${WORKSPACES[workspace].packageName}`);
  return [
    'turbo',
    'run',
    ...TURBO_CHECK_TASKS.filter((task) => typecheck || task !== TYPECHECK_TASK),
    '--ui=stream',
    ...filters,
  ];
}
/** Build a selected workspace format check from the shared root policy.
 * @example createWorkspaceFormatCommand('api');
 */
export function createWorkspaceFormatCommand(workspace: WorkspaceName): string[] {
  return ['bun', 'fmt', '--check', `apps/${workspace}`];
}
