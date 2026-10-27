import { FileText, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ICON_SM } from '@/lib/icon-sizes';

interface ContextWarningCalloutProps {
  title: string;
  detail: string;
  keepHistoryNote: string;
  compactLabel: string;
  newChatLabel: string;
  continueLabel: string;
  pendingLabel: string;
  /** A context action is running: every choice waits for it. */
  isPending: boolean;
  /**
   * Compact and New chat name the current model, so they wait for it to
   * resolve. Continue does not, and stays available.
   */
  modelActionsDisabled?: boolean;
  onCompact: () => void;
  onStartSummarizedChat: () => void;
  onContinue: () => void;
}

export function ContextWarningCallout({
  title,
  detail,
  keepHistoryNote,
  compactLabel,
  newChatLabel,
  continueLabel,
  pendingLabel,
  isPending,
  modelActionsDisabled = false,
  onCompact,
  onStartSummarizedChat,
  onContinue,
}: ContextWarningCalloutProps) {
  const modelActionBlocked = isPending || modelActionsDisabled;
  return (
    <Callout tone="warning" title={title} className="p-4">
      <div className="space-y-1">
        <p>{detail}</p>
        <p className="text-xs">{keepHistoryNote}</p>
      </div>
      <div className="flex flex-wrap gap-2 pt-3">
        <Button
          variant="primary"
          size="sm"
          disabled={modelActionBlocked}
          loading={isPending}
          onClick={onCompact}
        >
          <Sparkles size={ICON_SM} />
          {isPending ? pendingLabel : compactLabel}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={modelActionBlocked}
          onClick={onStartSummarizedChat}
        >
          <FileText size={ICON_SM} />
          {newChatLabel}
        </Button>
        <Button variant="subtle" size="sm" disabled={isPending} onClick={onContinue}>
          {continueLabel}
        </Button>
      </div>
    </Callout>
  );
}
