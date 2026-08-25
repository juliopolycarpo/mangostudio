/**
 * Which machines the hub is willing to interrupt the user about.
 *
 * Deliberately narrow. Most environments sit `disconnected` most of the time
 * and that is their resting state, not a fault — a card that listed every idle
 * remote would be a permanent red badge nobody reads. Two things earn a line:
 * a machine that reported an actual `error`, and the machine *this chat is
 * pointed at* being unreachable, which is the one that blocks the next turn.
 *
 * `connecting` is excluded on purpose: it resolves on its own within seconds,
 * and reporting it would make the card flicker on every reconnect.
 */

import type { Environment } from '@mangostudio/shared/environments';

export interface EnvironmentAlert {
  readonly environmentId: string;
  readonly name: string;
  readonly severity: 'error' | 'warning';
}

/**
 * // Usage: environmentAlerts(environments, chat.environmentId)
 */
export function environmentAlerts(
  environments: readonly Environment[],
  activeEnvironmentId: string | null
): readonly EnvironmentAlert[] {
  const alerts: EnvironmentAlert[] = [];
  for (const environment of environments) {
    if (!environment.enabled) continue;
    const { state } = environment.status;
    const severity =
      state === 'error'
        ? 'error'
        : state === 'disconnected' && environment.id === activeEnvironmentId
          ? 'warning'
          : null;
    if (severity === null) continue;
    alerts.push({ environmentId: environment.id, name: environment.name, severity });
  }
  // Faults first, then alphabetically, so the list is stable across refetches.
  return alerts.sort(
    (left, right) =>
      Number(right.severity === 'error') - Number(left.severity === 'error') ||
      left.name.localeCompare(right.name)
  );
}
