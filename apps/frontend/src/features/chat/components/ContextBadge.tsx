/**
 * How much of the model's window this chat has spent, as a composer chip.
 *
 * Escalates through the severity the context tracker already decided; at rest
 * it reads like every other chip on the strip, which is the point — a context
 * figure that shouts at 20% teaches people to ignore it at 95%.
 */

import type { ContextInfo } from '@/features/generation/types';
import { useI18n } from '@/hooks/use-i18n';

const SEVERITY_STYLES: Readonly<Record<ContextInfo['severity'], string>> = {
  critical: 'border-error/40 text-error',
  danger: 'border-warning/40 text-warning',
  warning: 'text-warning/80',
  info: '',
  normal: '',
};

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function ContextBadge({ info }: { info: ContextInfo }) {
  const { t } = useI18n();
  const used = formatTokensCompact(info.estimatedInputTokens);
  const limit = formatTokensCompact(info.contextLimit);

  return (
    <span
      className={`composer-chip tabular-nums ${SEVERITY_STYLES[info.severity]}`}
      data-testid="context-badge"
      data-severity={info.severity}
      title={`~${info.estimatedInputTokens.toLocaleString()} / ${info.contextLimit.toLocaleString()} tokens · ${info.mode}`}
    >
      <span className="shrink-0 opacity-70 max-sm:hidden">{`${t.chat.context.label}:`}</span>
      <span className="composer-chip-value text-inherit">{`${used}/${limit}`}</span>
    </span>
  );
}
