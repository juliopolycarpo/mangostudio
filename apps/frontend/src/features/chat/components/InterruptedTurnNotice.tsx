import type {
  ToolRetrySafety,
  TurnCheckpointPart,
  TurnInterruptionReasonCode,
} from '@mangostudio/shared/turn-recovery';
import { AlertTriangle, CheckCircle2, RotateCcw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';

interface InterruptedTurnNoticeProps {
  readonly messageId: string;
  readonly checkpoint: TurnCheckpointPart;
  readonly disabled: boolean;
  readonly onResume: (messageId: string, retryCallIds: string[]) => Promise<void>;
  readonly onDismiss: (messageId: string) => Promise<void>;
}

type PendingAction = 'resume' | 'dismiss' | null;

export function InterruptedTurnNotice({
  messageId,
  checkpoint,
  disabled,
  onResume,
  onDismiss,
}: InterruptedTurnNoticeProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [selectedRetries, setSelectedRetries] = useState<Set<string>>(
    () =>
      new Set(
        checkpoint.incompleteCalls
          .filter((call) => call.retrySafety === 'safe_read')
          .map((call) => call.callId)
      )
  );
  const isPending = pendingAction !== null;

  const runAction = async (action: Exclude<PendingAction, null>, callback: () => Promise<void>) => {
    setPendingAction(action);
    try {
      await callback();
    } catch {
      toast(t.chat.recovery.actionFailed, 'error');
    } finally {
      // A resume that no-ops (another turn already started) resolves without
      // unmounting this notice, so the controls must always be released.
      setPendingAction(null);
    }
  };

  const toggleRetry = (callId: string) => {
    setSelectedRetries((current) => {
      const next = new Set(current);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  };

  return (
    <div className="px-4 pt-3 sm:px-6" role="status" aria-live="polite">
      <Card
        variant="solid"
        padded={false}
        className="mx-auto max-w-4xl border-warning/25 bg-warning/8 p-4"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 shrink-0 text-warning" size={18} />
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-bold text-on-surface">{t.chat.recovery.title}</h2>
              <p className="text-sm text-on-surface-variant/80">
                {reasonLabel(checkpoint.reasonCode, t.chat.recovery.reason)}
              </p>
              <p className="text-xs text-on-surface-variant/60">{t.chat.recovery.detail}</p>
            </div>
          </div>

          {checkpoint.completedCalls.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wide text-on-surface-variant/70">
                {t.chat.recovery.completedCalls.replace(
                  '{count}',
                  String(checkpoint.completedCalls.length)
                )}
              </h3>
              <div className="flex flex-wrap gap-2">
                {checkpoint.completedCalls.map((call) => (
                  <span
                    key={call.callId}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-surface-container-high px-2.5 py-1 text-xs text-on-surface-variant"
                  >
                    <CheckCircle2
                      size={12}
                      className={call.isError ? 'text-error' : 'text-success'}
                    />
                    <span className="font-mono">{call.name}</span>
                    {call.isError && <span className="text-error">{t.chat.recovery.failed}</span>}
                  </span>
                ))}
              </div>
            </section>
          )}

          {checkpoint.incompleteCalls.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wide text-on-surface-variant/70">
                {t.chat.recovery.incompleteCalls.replace(
                  '{count}',
                  String(checkpoint.incompleteCalls.length)
                )}
              </h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {checkpoint.incompleteCalls.map((call) => (
                  <label
                    key={call.callId}
                    className="flex cursor-pointer items-center gap-3 rounded-xl border border-outline-variant/15 bg-surface-container-low px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selectedRetries.has(call.callId)}
                      disabled={disabled || isPending}
                      onChange={() => toggleRetry(call.callId)}
                      className="h-4 w-4 accent-primary"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-on-surface">
                      {call.name}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-on-surface-variant/70">
                      {call.retrySafety !== 'safe_read' && <ShieldAlert size={12} />}
                      {safetyLabel(call.retrySafety, t.chat.recovery)}
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-on-surface-variant/60">{t.chat.recovery.retryHint}</p>
            </section>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || isPending}
              loading={pendingAction === 'dismiss'}
              onClick={() => void runAction('dismiss', () => onDismiss(messageId))}
            >
              {pendingAction === 'dismiss' ? t.chat.recovery.dismissing : t.chat.recovery.dismiss}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={disabled || isPending}
              loading={pendingAction === 'resume'}
              onClick={() =>
                void runAction('resume', () => onResume(messageId, [...selectedRetries]))
              }
            >
              <RotateCcw size={14} />
              {pendingAction === 'resume' ? t.chat.recovery.resuming : t.chat.recovery.resume}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function safetyLabel(
  safety: ToolRetrySafety,
  labels: { safeRead: string; confirmationRequired: string; unknownSafety: string }
): string {
  if (safety === 'safe_read') return labels.safeRead;
  if (safety === 'confirmation_required') return labels.confirmationRequired;
  return labels.unknownSafety;
}

function reasonLabel(
  reason: TurnInterruptionReasonCode | undefined,
  labels: {
    clientDisconnect: string;
    serverRestart: string;
    providerError: string;
    userCancelled: string;
    toolLoopExhausted: string;
    unknown: string;
  }
): string {
  if (reason === 'client_disconnect') return labels.clientDisconnect;
  if (reason === 'server_restart') return labels.serverRestart;
  if (reason === 'provider_error') return labels.providerError;
  if (reason === 'user_cancelled') return labels.userCancelled;
  if (reason === 'tool_loop_exhausted') return labels.toolLoopExhausted;
  return labels.unknown;
}
