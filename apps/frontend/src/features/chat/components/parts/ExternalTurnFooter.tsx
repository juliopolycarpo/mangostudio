import type { ExternalTurnPart } from '@mangostudio/shared/types';
import { Callout } from '@/components/ui/Callout';
import { Chip } from '@/components/ui/Chip';
import { ExternalRemedyLink } from '@/features/external-agents/ExternalRemedyLink';
import { externalUnavailableText } from '@/features/external-agents/external-unavailable-text';
import { SignInCommand } from '@/features/external-agents/SignInCommand';
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

  if (fields.length === 0 && !terminalNotice && !part.error && !part.conversationReset) return null;

  // An error the hub can present is shown the way the selector shows the same state: its words,
  // the sign-in command to copy, or the install and update link. Two sources name it: the reason
  // the hub stored for a reopen the runtime refused, and a turn the agent refused because its
  // account is signed out (a remedy with no reason). The command is the hub's, never text out of
  // the vendor's error, and nothing here runs it.
  const signIn = part.remedy?.kind === 'sign-in' ? part.remedy : undefined;
  const presentedReason = part.unavailableReason ?? (signIn ? 'signed-out' : undefined);

  return (
    <div className="mt-2 max-w-2xl space-y-1.5 pl-4">
      {part.conversationReset ? (
        <Callout tone="warning" role="status" data-conversation-reset={part.conversationReset}>
          {labels.conversationReset[part.conversationReset]}
        </Callout>
      ) : null}
      {fields.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {fields.map(([label, value]) => (
            <Chip key={label} className="tabular-nums">
              {`${label} ${formatTokensCompact(value)}`}
            </Chip>
          ))}
        </div>
      ) : null}
      {part.error && presentedReason ? (
        <Callout tone="danger">
          <div className="space-y-1.5">
            <p className="text-fg">
              {externalUnavailableText(presentedReason, t, part.requiredVersion)}
            </p>
            {signIn?.command ? <SignInCommand command={signIn.command} /> : null}
            {part.remedy ? <ExternalRemedyLink remedy={part.remedy} /> : null}
          </div>
        </Callout>
      ) : part.error ? (
        <Callout tone="danger">
          {/* The vendor's own code and message, inert and unflattened. */}
          <span className="font-mono">{part.error.code}</span>
          {` — ${part.error.message}`}
        </Callout>
      ) : null}
      {terminalNotice && !isStreaming ? (
        <p className="text-xs text-fg-muted">{terminalNotice}</p>
      ) : null}
    </div>
  );
}
