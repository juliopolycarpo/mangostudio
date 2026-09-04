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
import type {
  InstallManager,
  MachineUpdateStatus,
  UpgradeRefusalReason,
} from '@mangostudio/shared/updates';
import { formatMessage } from '@/lib/i18n-format';
import { guardReasonLabel } from '../format';

export function launchModeLabel(t: Messages, launch: HubLaunchMode): string {
  return t.environments.machine.hub.launch[launch];
}

export function hubHealthLabel(t: Messages, health: HubHealth): string {
  return t.environments.machine.hub.health[health];
}

/**
 * How each health reads at a glance, in one place so the card and the overview
 * rollup cannot disagree. `unprobed` is not a failure — a hub bound to one LAN
 * address simply cannot be measured from here — so it is neutral, not red.
 */
export const HUB_HEALTH_TONE: Record<HubHealth, { readonly badge: string; readonly text: string }> =
  {
    ok: { badge: 'bg-primary/10 text-primary', text: 'text-primary' },
    unreachable: { badge: 'bg-error/10 text-error', text: 'text-error' },
    unprobed: {
      badge: 'bg-on-surface-variant/10 text-on-surface-variant',
      text: 'text-on-surface-variant',
    },
  };

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
 * The sentences behind one refusal: the action's own reason, or — when the
 * reason is the guard — the guard's individual checks. Shared so a new reason
 * kind is worded once; what each caller does with an empty result differs and
 * stays with the caller.
 */
function refusalLines(
  t: Messages,
  reason: MachineActionReason | null,
  guardReasons: readonly InstallGuardReason[]
): string[] {
  if (reason && reason !== 'guard') return [actionReasonLabel(t, reason)];
  return guardReasons.map((entry) => machineGuardReasonLabel(t, entry));
}

/**
 * Why the API refused an action it had advertised as available — the status the
 * page was showing went stale between the render and the POST, so the reason
 * arrives with the response rather than in `actions`. Same sentences as
 * {@link actionRefusalLines}, joined for a toast — and a toast has to say
 * something, so an empty result falls back rather than showing nothing.
 * // Usage: refusalMessage(t, { reason: 'foreground', reasons: [] })
 */
export function refusalMessage(
  t: Messages,
  refusal: {
    readonly reason: MachineActionReason | null;
    readonly reasons: readonly InstallGuardReason[];
  }
): string {
  const lines = refusalLines(t, refusal.reason, refusal.reasons);
  if (lines.length > 0) return lines.join(' ');
  return refusal.reason
    ? actionReasonLabel(t, refusal.reason)
    : t.environments.machine.actions.refused;
}

/**
 * Every sentence that explains why one action is unavailable, in the order the
 * user should read them: the guard's checks first, then the action's own. An
 * available action has nothing to explain, so the list is empty.
 */
export function actionRefusalLines(
  t: Messages,
  status: Pick<MachineStatus, 'actions'>,
  action: keyof Omit<MachineStatus['actions'], 'guard'>
): string[] {
  const entry = status.actions[action];
  if (entry.available || !entry.reason) return [];
  return refusalLines(t, entry.reason, status.actions.guard.reasons);
}

/** Which tool owns the running binary, worded for a reader rather than a wire id. */
export function installedViaManagerLabel(t: Messages, manager: InstallManager): string {
  return t.environments.machine.update.manager[manager];
}

/** Why the hub refuses to upgrade itself, for a `POST /machine/upgrade` 409 or a `refused` report. */
export function upgradeRefusalReasonLabel(t: Messages, reason: UpgradeRefusalReason): string {
  return t.environments.machine.update.refusalReasons[reason];
}

/**
 * The "Latest" row on the update card: checks disabled, never checked, the
 * check's own error, or the version comparison — in that order, so a check
 * that failed reads as "we tried and this is why" rather than "not checked".
 */
export function updateLatestLabel(
  t: Messages,
  status: Pick<MachineUpdateStatus, 'checksEnabled' | 'check'>
): string {
  const m = t.environments.machine.update;
  if (!status.checksEnabled) return m.checksDisabled;
  const check = status.check;
  if (!check) return m.notCheckedYet;
  if (check.error) return check.error;
  if (check.updateAvailable) {
    return formatMessage(m.updateAvailable, { version: check.latestVersion ?? '' });
  }
  return formatMessage(m.upToDate, { version: check.currentVersion });
}
