import type { ReasoningEffort } from '@mangostudio/shared';

export const EFFORT_DISPLAY_ORDER: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const EFFORT_LABEL_KEYS: Record<ReasoningEffort, string> = {
  low: 'effortLow',
  medium: 'effortMedium',
  high: 'effortHigh',
  xhigh: 'effortXHigh',
  max: 'effortMax',
};
