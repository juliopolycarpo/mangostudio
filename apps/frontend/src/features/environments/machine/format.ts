/**
 * Words for the machine page: launch modes, health, supervisor kinds, and the
 * reasons an action is refused. Everything here reads from i18n so a code on
 * the wire never reaches the screen as a code.
 */

import type { InstallGuardReason } from '@mangostudio/shared/environments';
import type { Messages } from '@mangostudio/shared/i18n';
import type {
  HubHealth,
  HubLaunchMode,
  MachineActionReason,
  MachineStatus,
} from '@mangostudio/shared/machine';
import type { UserServicePlatform } from '@mangostudio/shared/runtime-home';
import { guardReasonLabel } from '../format';

export function launchModeLabel(t: Messages, launch: HubLaunchMode): string {
  return t.environments.machine.hub.launch[launch];
}

export function hubHealthLabel(t: Messages, health: HubHealth): string {
  return t.environments.machine.hub.health[health];
}

export function supervisorLabel(t: Messages, platform: UserServicePlatform): string {
  return t.environments.machine.service.supervisor[platform];
}

/**
 * Why an action is off. The guard's own reasons get sentences about restarts
 * and services; a guard reason the machine page has no sentence for falls back
 * to the install wording, which at least names the check.
 */
export function machineGuardReasonLabel(t: Messages, reason: InstallGuardReason): string {
  const specific = t.environments.machine.actions.guard as Partial<
    Record<InstallGuardReason, string>
  >;
  return specific[reason] ?? guardReasonLabel(t, reason);
}

function actionReasonLabel(t: Messages, reason: MachineActionReason): string {
  return t.environments.machine.actions.reasons[reason];
}

/**
 * Every sentence that explains why one action is unavailable, in the order the
 * user should read them: the guard's checks first, then the action's own.
 */
export function actionRefusalLines(
  t: Messages,
  status: Pick<MachineStatus, 'actions'>,
  action: keyof Omit<MachineStatus['actions'], 'guard'>
): string[] {
  const entry = status.actions[action];
  if (entry.available || !entry.reason) return [];
  if (entry.reason === 'guard') {
    return status.actions.guard.reasons.map((reason) => machineGuardReasonLabel(t, reason));
  }
  return [actionReasonLabel(t, entry.reason)];
}
