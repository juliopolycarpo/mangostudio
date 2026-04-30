import { AlertTriangle, FileText, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';

interface ContextWarningCalloutProps {
  title: string;
  detail: string;
  keepHistoryNote: string;
  compactLabel: string;
  newChatLabel: string;
  continueLabel: string;
  pendingLabel: string;
  isPending: boolean;
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
  onCompact,
  onStartSummarizedChat,
  onContinue,
}: ContextWarningCalloutProps) {
  return (
    <Card variant="solid" className="border-warning/20 bg-warning/8 p-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-warning">
            <AlertTriangle size={16} />
            <span className="text-sm font-bold">{title}</span>
          </div>
          <p className="text-sm text-on-surface-variant/80">{detail}</p>
          <p className="text-xs text-on-surface-variant/60">{keepHistoryNote}</p>
        </div>
        <div className="flex flex-wrap gap-2 md:justify-end">
          <Button
            variant="primary"
            size="sm"
            disabled={isPending}
            loading={isPending}
            onClick={onCompact}
          >
            <Sparkles size={14} />
            {isPending ? pendingLabel : compactLabel}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={isPending}
            onClick={onStartSummarizedChat}
          >
            <FileText size={14} />
            {newChatLabel}
          </Button>
          <Button variant="ghost" size="sm" disabled={isPending} onClick={onContinue}>
            {continueLabel}
          </Button>
        </div>
      </div>
    </Card>
  );
}
