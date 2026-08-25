import type { EnvironmentConnectionState } from '@mangostudio/shared/environments';
import { recordActivity } from '../../activity/application/record-activity';

export interface EnvironmentStateTransition {
  readonly userId: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly previousState: EnvironmentConnectionState;
  readonly state: EnvironmentConnectionState;
}

export type EnvironmentStateTransitionRecorder = (transition: EnvironmentStateTransition) => void;

/**
 * Files a machine coming back, or going away, on the account's timeline.
 *
 * Deliberately a transition and not a poll: the environments card already shows
 * which machines are down right now, and re-reporting that on every read would
 * bury the thing this event exists for — "wsl dropped at 14:02, back at 14:09",
 * which nothing else in the product can tell you afterwards.
 */
export function recordEnvironmentStateTransition(transition: EnvironmentStateTransition): void {
  void recordActivity({
    userId: transition.userId,
    kind: 'environment_health_changed',
    environmentId: transition.environmentId,
    payload: {
      environmentName: transition.environmentName,
      previousState: transition.previousState,
      state: transition.state,
    },
  });
}
