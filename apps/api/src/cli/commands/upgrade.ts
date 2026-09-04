/**
 * `upgrade`/`update` command: preview or carry out `createUpgradeService`'s
 * plan for this install, with the CLI's own confirmation prompts layered on
 * top — the engine itself never prompts (see upgrade-service.ts).
 */

import type { UpgradeReport, UpgradeStreamEvent } from '@mangostudio/shared/updates';
import { readState } from '../../lib/server-state';
import {
  createUpgradeService,
  type UpgradeRunRequest,
  type UpgradeService,
} from '../../modules/updates/application/upgrade-service';
import type { UpgradeArgs } from '../args';
import { writeLine } from '../output';
import { createProcessController, type ProcessController } from '../process-control';
import { promptYesNo } from '../prompt';

export interface UpgradeCliDeps {
  readonly service: UpgradeService;
  readonly readState: typeof readState;
  readonly controller: ProcessController;
  readonly isInteractive: () => boolean;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly log: (message: string) => void;
}

/** Preview, confirm, and run (or roll back) an upgrade. // Usage: await runUpgrade(parseUpgradeArgs(rest)) */
export async function runUpgrade(
  args: UpgradeArgs,
  deps: Partial<UpgradeCliDeps> = {}
): Promise<number> {
  const d = resolveDeps(deps);
  return args.rollback ? await runRollback(args, d) : await runUpgradeFlow(args, d);
}

function baseRequest(args: UpgradeArgs): Omit<UpgradeRunRequest, 'restart' | 'checkOnly'> {
  return {
    ...(args.channel !== undefined ? { channel: args.channel } : {}),
    ...(args.version !== undefined ? { version: args.version } : {}),
    ...(args.sha !== undefined ? { sha: args.sha } : {}),
  };
}

async function runUpgradeFlow(args: UpgradeArgs, d: Required<UpgradeCliDeps>): Promise<number> {
  const request = baseRequest(args);

  if (args.check) {
    const report = await d.service.run(
      { ...request, restart: !args.noRestart, checkOnly: true },
      () => undefined
    );
    printFinal(report, args, d);
    return report.exitCode;
  }

  if (args.yes) {
    return await streamAndPrint(
      { ...request, restart: !args.noRestart, checkOnly: false },
      args,
      d
    );
  }

  // The unconfirmed path previews first: a self plan with an update available
  // resolves without downloading (outcome: 'available'); anything else — no
  // update, a refusal, a resolver failure — is already the final report.
  const preview = await d.service.run(
    { ...request, restart: !args.noRestart, checkOnly: true },
    () => undefined
  );
  if (preview.outcome !== 'available') {
    printFinal(preview, args, d);
    return preview.exitCode;
  }

  const interactive = d.isInteractive();
  const proceed =
    interactive &&
    (await d.confirm(
      `Upgrade ${preview.currentVersion} → ${preview.target?.version} on ${preview.target?.channel}?`
    ));
  if (!proceed) {
    // Non-interactive or declined: the preview report already says what is
    // available and is exit 0 — "no" to a download is not a failure.
    printFinal(preview, args, d);
    return preview.exitCode;
  }

  const restart = await resolveRestartFlag(args, d, interactive);
  return await streamAndPrint({ ...request, restart, checkOnly: false }, args, d);
}

async function runRollback(args: UpgradeArgs, d: Required<UpgradeCliDeps>): Promise<number> {
  if (!args.yes) {
    const proceed = d.isInteractive() && (await d.confirm('Roll back to the previous version?'));
    if (!proceed) {
      d.log('Rollback needs --yes, or a yes at the prompt, to proceed.');
      return 0;
    }
  }

  const emit = args.json ? noopEmit : (event: UpgradeStreamEvent) => printEvent(event, d.log);
  const report = await d.service.rollback(emit, { restart: !args.noRestart });
  printFinal(report, args, d);
  return report.exitCode;
}

async function streamAndPrint(
  request: UpgradeRunRequest,
  args: UpgradeArgs,
  d: Required<UpgradeCliDeps>
): Promise<number> {
  const emit = args.json ? noopEmit : (event: UpgradeStreamEvent) => printEvent(event, d.log);
  const report = await d.service.run(request, emit);
  printFinal(report, args, d);
  return report.exitCode;
}

function noopEmit(): void {
  // --json prints only the final report; stage/output events are dropped.
}

/**
 * Whether the real (non-preview) request should ask the hub to restart.
 * `--no-restart` always wins; a non-interactive or already-confirmed
 * (`--yes`) run restarts by default; an interactive run confirms only when a
 * hub is actually live to restart.
 */
async function resolveRestartFlag(
  args: UpgradeArgs,
  d: Required<UpgradeCliDeps>,
  interactive: boolean
): Promise<boolean> {
  if (args.noRestart) return false;
  if (!interactive) return true;
  const state = await d.readState();
  const alive = state !== null && d.controller.isAlive(state.pid);
  if (!alive) return true;
  return await d.confirm('Restart the running hub once the upgrade finishes installing?');
}

function printEvent(event: UpgradeStreamEvent, log: (message: string) => void): void {
  if (event.type === 'stage') {
    log(`→ ${event.stage}${event.detail ? `: ${event.detail}` : ''}`);
    return;
  }
  if (event.type === 'output') {
    log(event.line);
  }
  // 'done' and 'error' are never emitted by the engine itself (see
  // upgrade-service.ts's module docstring); nothing to print for either here.
}

function printFinal(report: UpgradeReport, args: UpgradeArgs, d: Required<UpgradeCliDeps>): void {
  if (args.json) {
    d.log(JSON.stringify(report, null, 2));
    return;
  }
  d.log(outcomeSentence(report));
}

function outcomeSentence(report: UpgradeReport): string {
  switch (report.outcome) {
    case 'already-current':
      return `MangoStudio is already up to date (${report.currentVersion}).`;
    case 'available':
      return (
        `A newer build is available: ${report.target?.version} (${report.target?.channel}). ` +
        'Re-run with --yes to install it.'
      );
    case 'upgraded': {
      const version = report.target?.version ?? 'the requested version';
      const restartNote = restartSentence(report);
      return `Upgraded to ${version}.${restartNote ? ` ${restartNote}` : ''}${report.message ? ` ${report.message}` : ''}`;
    }
    case 'refused':
      return `${report.message ?? 'MangoStudio will not upgrade itself here.'}${
        report.command ? ` Run: ${report.command}` : ''
      }`;
    case 'failed':
      return `Upgrade failed: ${report.message ?? 'unknown error.'}`;
  }
}

function restartSentence(report: UpgradeReport): string | null {
  switch (report.restart) {
    case 'scheduled':
      return 'Restarting.';
    case 'manual':
      return 'Restart it yourself: "mangostudio restart".';
    case 'not-running':
    case 'skipped':
    case undefined:
      return null;
  }
}

function resolveDeps(deps: Partial<UpgradeCliDeps>): Required<UpgradeCliDeps> {
  return {
    service: deps.service ?? createUpgradeService(),
    readState: deps.readState ?? readState,
    controller: deps.controller ?? createProcessController(),
    isInteractive:
      deps.isInteractive ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY)),
    confirm: deps.confirm ?? promptYesNo,
    log: deps.log ?? writeLine,
  };
}
