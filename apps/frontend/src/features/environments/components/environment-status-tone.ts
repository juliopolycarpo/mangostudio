import type { EnvironmentConnectionState } from '@mangostudio/shared/environments';
import type { StatusDotTone } from '@/components/ui/StatusDot';

/**
 * The dot a machine's connection state wears wherever one is drawn beside its
 * name. A connection that is still getting there pulses; the word that goes
 * with the dot carries the state for anyone who cannot read the colour.
 */
export const ENVIRONMENT_STATE_TONE: Record<EnvironmentConnectionState, StatusDotTone> = {
  connected: 'success',
  connecting: 'warning',
  disconnected: 'neutral',
  error: 'error',
};
