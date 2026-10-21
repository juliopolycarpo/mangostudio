import type {
  ToolRetrySafety,
  TurnCheckpointPart,
  TurnInterruptionReasonCode,
} from '@mangostudio/shared/turn-recovery';
import { RotateCcw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { ChatDockNotice } from './ChatPageNotices';
import { StatusGlyph } from './ToolCallVisuals';

interface InterruptedTurnNoticeProps {
  readonly messageId: string;
  readonly checkpoint: TurnCheckpointPart;
  readonly disabled: boolean;
  readonly onResume: (messageId: string, retryCallIds: string[]) => Promise<void>;
  readonly onDismiss: (messageId: string) => Promise<void>;
  /**
   * `secondary` while another notice above the composer already offers the
   * region's one primary action (the context decision's "Compact and continue"):
   * two accent buttons stacked over Send put three mango buttons within a
   * thumb's reach, and none of them reads as the way forward.
   */
  readonly resumeVariant?: 'primary' | 'secondary';
}

type PendingAction = 'resume' | 'dismiss' | null;

export function InterruptedTurnNotice({
  messageId,
  checkpoint,
  disabled,
  onResume,
  onDismiss,
  resumeVariant = 'primary',
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
    <ChatDockNotice role="status" aria-live="polite">
      <Callout tone="warning" title={t.chat.recovery.title} className="p-4">
        <div className="space-y-4">
          <div className="min-w-0 space-y-1">
            <p className="text-sm">{reasonLabel(checkpoint.reasonCode, t.chat.recovery.reason)}</p>
            <p className="text-xs">{t.chat.recovery.detail}</p>
          </div>

          {checkpoint.completedCalls.length > 0 && (
            <section className="space-y-2">
              <MicroLabel as="h3">
                {t.chat.recovery.completedCalls.replace(
                  '{count}',
                  String(checkpoint.completedCalls.length)
                )}
              </MicroLabel>
              <div className="flex flex-wrap gap-2">
                {checkpoint.completedCalls.map((call) => (
                  <span key={call.callId} className="terminal-chip">
                    {/* The same verdict marks the tool rail draws for these calls:
                        a check for one that finished, an alert for one that failed. */}
                    <span
                      className={
                        call.isError ? 'inline-flex text-danger' : 'inline-flex text-success'
                      }
                    >
                      <StatusGlyph
                        status={call.isError ? 'failed' : 'succeeded'}
                        name={call.name}
                      />
                    </span>
                    <span>{call.name}</span>
                    {call.isError && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{t.chat.recovery.failed}</span>
                      </>
                    )}
                  </span>
                ))}
              </div>
            </section>
          )}

          {checkpoint.incompleteCalls.length > 0 && (
            <section className="space-y-2">
              <MicroLabel as="h3">
                {t.chat.recovery.incompleteCalls.replace(
                  '{count}',
                  String(checkpoint.incompleteCalls.length)
                )}
              </MicroLabel>
              <div className="grid gap-2 sm:grid-cols-2">
                {checkpoint.incompleteCalls.map((call) => (
                  <label
                    key={call.callId}
                    className="flex min-h-8 cursor-pointer items-center gap-3 rounded-sm border border-stroke bg-surface px-3 py-1.5 text-sm pointer-coarse:min-h-11"
                  >
                    <Checkbox
                      checked={selectedRetries.has(call.callId)}
                      disabled={disabled || isPending}
                      onChange={() => toggleRetry(call.callId)}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                      {call.name}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-muted">
                      {call.retrySafety !== 'safe_read' && <ShieldAlert size={ICON_SM} />}
                      {safetyLabel(call.retrySafety, t.chat.recovery)}
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-xs">{t.chat.recovery.retryHint}</p>
            </section>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="subtle"
              size="sm"
              disabled={disabled || isPending}
              loading={pendingAction === 'dismiss'}
              onClick={() => void runAction('dismiss', () => onDismiss(messageId))}
            >
              {pendingAction === 'dismiss' ? t.chat.recovery.dismissing : t.chat.recovery.dismiss}
            </Button>
            <Button
              type="button"
              variant={resumeVariant}
              size="sm"
              disabled={disabled || isPending}
              loading={pendingAction === 'resume'}
              onClick={() =>
                void runAction('resume', () => onResume(messageId, [...selectedRetries]))
              }
            >
              <RotateCcw size={ICON_SM} />
              {pendingAction === 'resume' ? t.chat.recovery.resuming : t.chat.recovery.resume}
            </Button>
          </div>
        </div>
      </Callout>
    </ChatDockNotice>
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
