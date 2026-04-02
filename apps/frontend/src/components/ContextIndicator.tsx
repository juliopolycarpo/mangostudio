import { useI18n } from '@/hooks/use-i18n';
import type { ContextInfo } from '@/hooks/use-text-chat';

interface ContextIndicatorProps {
  contextInfo: ContextInfo | null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const severityClass: Record<ContextInfo['severity'], string> = {
  normal: 'context-indicator--normal',
  info: 'context-indicator--info',
  warning: 'context-indicator--warning',
  danger: 'context-indicator--danger',
  critical: 'context-indicator--critical',
};

export function ContextIndicator({ contextInfo }: ContextIndicatorProps) {
  const { t } = useI18n();

  if (!contextInfo) return null;

  const { estimatedInputTokens, contextLimit, mode, severity } = contextInfo;
  const usedLabel = formatTokens(estimatedInputTokens);
  const limitLabel = formatTokens(contextLimit);

  const modeLabels: Record<ContextInfo['mode'], string> = {
    stateful: t.chat.context.modeStateful,
    replay: t.chat.context.modeReplay,
    compacted: t.chat.context.modeCompacted,
    degraded: t.chat.context.modeDegraded,
  };

  const tokensLabel = t.chat.context.tokens
    .replace('{used}', usedLabel)
    .replace('{limit}', limitLabel);

  return (
    <div className={`context-indicator ${severityClass[severity]}`}>
      <span className="context-indicator__label">{t.chat.context.label}</span>
      <span className="context-indicator__tokens">{tokensLabel}</span>
      <span className="context-indicator__mode">{modeLabels[mode]}</span>
    </div>
  );
}

interface ContextWarningProps {
  contextInfo: ContextInfo | null;
}

export function ContextWarning({ contextInfo }: ContextWarningProps) {
  const { t } = useI18n();

  if (!contextInfo) return null;
  const { severity } = contextInfo;
  if (severity === 'normal' || severity === 'info') return null;

  const message =
    severity === 'critical'
      ? t.chat.context.critical
      : severity === 'danger'
        ? t.chat.context.danger
        : t.chat.context.warning;

  return (
    <div className={`context-warning context-warning--${severity}`}>
      <span>{message}</span>
    </div>
  );
}
