import type { SSEContextEvent, SSEFallbackEvent } from '@mangostudio/shared/streaming';

export type ContextInfo = Pick<
  SSEContextEvent,
  'estimatedInputTokens' | 'contextLimit' | 'estimatedUsageRatio' | 'mode' | 'severity'
>;

export type FallbackNotice = Pick<SSEFallbackEvent, 'from' | 'to' | 'reason'>;
