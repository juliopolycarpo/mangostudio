/**
 * Compact token figures for external turns — only fields the vendor reported.
 * Renders nothing until at least one reported field arrives (absent ≠ zero).
 */

import type { ExternalThreadUsage, ExternalUsage } from '@mangostudio/shared/external-agents';
import { useI18n } from '@/hooks/use-i18n';

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function usageFields(usage: ExternalUsage): Array<{ key: string; value: number }> {
  const fields: Array<{ key: string; value: number }> = [];
  if (usage.inputTokens !== undefined) fields.push({ key: 'input', value: usage.inputTokens });
  if (usage.outputTokens !== undefined) fields.push({ key: 'output', value: usage.outputTokens });
  if (usage.totalTokens !== undefined) fields.push({ key: 'total', value: usage.totalTokens });
  return fields;
}

export function ExternalUsageDisplay({
  turn,
  thread,
}: {
  turn?: ExternalUsage | null;
  thread?: ExternalThreadUsage | null;
}) {
  const { t } = useI18n();
  const labels = t.externalAgents.usage;

  const turnFields = turn ? usageFields(turn) : [];
  const threadTotal = thread?.total;
  const threadFields = threadTotal ? usageFields(threadTotal) : [];

  if (turnFields.length === 0 && threadFields.length === 0) {
    return null;
  }

  return (
    <span
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] sm:text-[11px] text-on-surface-variant/70 tabular-nums"
      data-testid="external-usage"
    >
      {turnFields.length > 0 ? (
        <span data-testid="external-usage-turn">
          {labels.turnLabel}:{' '}
          {turnFields
            .map((field) => {
              const name =
                field.key === 'input'
                  ? labels.input
                  : field.key === 'output'
                    ? labels.output
                    : labels.total;
              return `${name} ${formatTokensCompact(field.value)}`;
            })
            .join(' · ')}
        </span>
      ) : null}
      {threadFields.length > 0 ? (
        <span data-testid="external-usage-thread">
          {labels.threadLabel}:{' '}
          {threadFields
            .map((field) => {
              const name =
                field.key === 'input'
                  ? labels.input
                  : field.key === 'output'
                    ? labels.output
                    : labels.total;
              return `${name} ${formatTokensCompact(field.value)}`;
            })
            .join(' · ')}
        </span>
      ) : null}
    </span>
  );
}
