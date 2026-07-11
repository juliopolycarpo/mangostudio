// Task builders for the workflow static-analysis lane: actionlint over
// `.github/workflows/**` (with the pinned ShellCheck for embedded `run:`
// scripts), zizmor over workflows + composite actions in blocking
// pedantic/high-confidence mode, and ShellCheck over tracked `*.sh` files.

import { ROOT_DIR } from '../config';
import { type RunResult, runCommand } from '../exec';
import { ensureTool } from './bootstrap';
import type { ToolName } from './manifest';

/** Paths that must trigger repository-wide workflow analysis in scoped runs. */
export function touchesActionsLintSurface(files: string[]): boolean {
  return files.some(
    (file) =>
      file.startsWith('.github/') ||
      file.startsWith('scripts/lib/actions-lint/') ||
      file.endsWith('.sh')
  );
}

export function createActionlintCommand(actionlintBin: string, shellcheckBin: string): string[] {
  return [actionlintBin, '-shellcheck', shellcheckBin];
}

export function createZizmorCommand(zizmorBin: string): string[] {
  // Offline audits only: the blocking gate must not flake on network access.
  return [
    zizmorBin,
    '--no-online-audits',
    '--persona',
    'pedantic',
    '--min-confidence',
    'high',
    '.',
  ];
}

export function createShellcheckCommand(shellcheckBin: string, scriptFiles: string[]): string[] {
  // -x follows `source`d files declared via `# shellcheck source=` directives,
  // resolved against each script's own directory.
  return [shellcheckBin, '-x', '--source-path=SCRIPTDIR', '--', ...scriptFiles];
}

export interface ActionsLintDeps {
  ensure: (name: ToolName) => Promise<string>;
  run: (label: string, cmd: string[]) => Promise<RunResult>;
  listShellScripts: () => string[];
}

const defaultDeps: ActionsLintDeps = {
  ensure: (name) => ensureTool(name),
  run: (label, cmd) => runCommand(label, cmd, { cwd: ROOT_DIR }),
  listShellScripts: () => {
    const result = Bun.spawnSync(['git', 'ls-files', '*.sh'], { cwd: ROOT_DIR });
    if (!result.success) {
      throw new Error(result.stderr.toString().trim() || 'git ls-files *.sh failed');
    }
    return result.stdout.toString().split('\n').filter(Boolean);
  },
};

function toBootstrapFailure(label: string, caught: unknown): RunResult {
  console.error(caught instanceof Error ? caught.message : String(caught));
  return { label, exitCode: 1, duration: 0 };
}

/** Build the three parallel lint tasks; bootstrap failures fail the task. */
export function createActionsLintTasks(
  deps: ActionsLintDeps = defaultDeps
): Array<() => Promise<RunResult>> {
  return [
    async () => {
      try {
        const [actionlint, shellcheck] = await Promise.all([
          deps.ensure('actionlint'),
          deps.ensure('shellcheck'),
        ]);
        return await deps.run('root:actionlint', createActionlintCommand(actionlint, shellcheck));
      } catch (caught) {
        return toBootstrapFailure('root:actionlint', caught);
      }
    },
    async () => {
      try {
        const zizmor = await deps.ensure('zizmor');
        return await deps.run('root:zizmor', createZizmorCommand(zizmor));
      } catch (caught) {
        return toBootstrapFailure('root:zizmor', caught);
      }
    },
    async () => {
      try {
        const shellcheck = await deps.ensure('shellcheck');
        const scripts = deps.listShellScripts();
        if (scripts.length === 0) {
          return { label: 'root:shellcheck', exitCode: 0, duration: 0 };
        }
        return await deps.run('root:shellcheck', createShellcheckCommand(shellcheck, scripts));
      } catch (caught) {
        return toBootstrapFailure('root:shellcheck', caught);
      }
    },
  ];
}
