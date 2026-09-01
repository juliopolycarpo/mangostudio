import type { ExternalTurnPart } from '@mangostudio/shared/types';
import { useI18n } from '@/hooks/use-i18n';
import { formatTokensCompact } from '@/lib/format-tokens';

interface ExternalTurnFooterProps {
  part: ExternalTurnPart;
  isStreaming: boolean;
}

/**
 * What the vendor spent and why the turn stopped.
 *
 * Usage renders only the fields the vendor reported, and no total is computed
 * from them: an adapter reports what its vendor reports, and a sum MangoStudio
 * invented would read as the vendor's own number. Cost is out of scope entirely.
 *
 * // Usage: <ExternalTurnFooter part={externalTurn} isStreaming={isStreaming} />
 */
export function ExternalTurnFooter({ part, isStreaming }: ExternalTurnFooterProps) {
  const { t } = useI18n();
  const labels = t.externalAgents.turn;
  const usage = part.usage;
  const fields: Array<[string, number]> = usage
    ? (
        [
          [labels.usageInput, usage.inputTokens],
          [labels.usageOutput, usage.outputTokens],
          [labels.usageReasoning, usage.reasoningTokens],
          [labels.usageCacheRead, usage.cacheReadTokens],
          [labels.usageCacheWrite, usage.cacheWriteTokens],
          [labels.usageTotal, usage.totalTokens],
        ] as const
      ).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    : [];

  const terminalNotice =
    part.status === 'terminal' && part.terminalReason && part.terminalReason !== 'completed'
      ? labels.terminal[part.terminalReason]
      : null;

  if (fields.length === 0 && !terminalNotice && !part.error) return null;

  return (
    <div className="mt-2 max-w-2xl space-y-1.5 pl-4">
      {fields.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {fields.map(([label, value]) => (
            <span
              key={label}
              className="rounded-full border border-outline-variant/20 bg-surface-container-lowest px-2 py-0.5 text-[10px] tabular-nums text-on-surface-variant"
            >
              {`${label} ${formatTokensCompact(value)}`}
            </span>
          ))}
        </div>
      ) : null}
      {part.error ? (
        <p className="rounded-xl border border-error/20 bg-error/10 px-3 py-2 text-xs text-error">
          {/* The vendor's own code and message, inert and unflattened. */}
          <span className="font-mono">{part.error.code}</span>
          {` — ${part.error.message}`}
        </p>
      ) : null}
      {terminalNotice && !isStreaming ? (
        <p className="text-xs text-on-surface-variant/70">{terminalNotice}</p>
      ) : null}
    </div>
  );
}
