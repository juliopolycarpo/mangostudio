/**
 * What happens to the running hub once an upgrade's pointer has moved: one
 * table, so the CLI's inline restart and the machine API's deferred one
 * cannot disagree about when a restart is scheduled, refused as manual, or
 * simply not applicable. The effect itself — actually bouncing the process —
 * lives with each caller; this only decides what the report should say.
 */

import type { HubLaunchMode } from '@mangostudio/shared/machine';
import type { UpgradeRestart } from '@mangostudio/shared/updates';

const WINDOWS_SERVICE_NOTE =
  'A Scheduled Task cannot stop or restart itself from inside its own process. ' +
  'Run "mangostudio restart" once this exits.';

export interface DecideRestartInput {
  /** Null when no live hub owns the state file. */
  readonly launch: HubLaunchMode | null;
  readonly platform: NodeJS.Platform;
  /** `request.restart`; false is `--no-restart`. */
  readonly restart: boolean;
}

export interface RestartDecision {
  readonly restart: UpgradeRestart;
  readonly message?: string;
}

/**
 * Decide what an upgrade's restart stage should report, before anything is
 * actually restarted.
 * // Usage: decideRestart({ launch: 'service', platform: 'win32', restart: true })
 */
export function decideRestart(input: DecideRestartInput): RestartDecision {
  if (!input.restart) return { restart: 'skipped' };
  if (input.launch === null) return { restart: 'not-running' };
  if (input.launch === 'foreground') return { restart: 'manual' };
  if (input.launch === 'service' && input.platform === 'win32') {
    return { restart: 'manual', message: WINDOWS_SERVICE_NOTE };
  }
  return { restart: 'scheduled' };
}
