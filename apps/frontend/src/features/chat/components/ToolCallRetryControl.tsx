import {
  resolveToolCallRetryEligibility,
  type ToolExecutionSnapshot,
  type ToolExecutionStatus,
} from '@mangostudio/shared/tool-executions';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useState } from 'react';

import { createLazyOverlay } from '@/components/layout/LazyOverlay';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import { retryToolCallStream } from '@/services/generation-service';

import { messageKeys } from '../queries';
import { useToolCallRetryScope } from './ToolCallRetryContext';
import type { ToolCallRetryDialogProps } from './ToolCallRetryDialog';

// The dialog is only shown after a press, so it ships in its own chunk.
const retryDialog = createLazyOverlay<ToolCallRetryDialogProps>(() =>
  import('./ToolCallRetryDialog').then((m) => ({ default: m.default }))
);

interface ToolCallRetryControlProps {
  readonly toolCallId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly status: ToolExecutionStatus;
  readonly execution?: ToolExecutionSnapshot;
  /** The owning turn is still streaming; nothing can be retried under it. */
  readonly isLiveTurn: boolean;
}

/**
 * The Retry button of a settled tool card, or nothing where a retry is not on
 * offer. Eligibility is the shared policy the hub applies to the request, read
 * from the snapshot the call recorded when it started: a legacy call with no
 * snapshot, a refused call and a call that already has a retry get no button.
 *
 * A read runs on press. Any other call opens a confirmation naming the tool and
 * its arguments first. The hub makes the final call either way: a turn that is
 * running in the chat refuses the request.
 *
 * // Usage: <ToolCallRetryControl toolCallId={id} name={name} args={args} status={status} … />
 */
export function ToolCallRetryControl({
  toolCallId,
  name,
  args,
  status,
  execution,
  isLiveTurn,
}: ToolCallRetryControlProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const scope = useToolCallRetryScope();
  const [confirming, setConfirming] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  if (scope === null || isLiveTurn || scope.retriedCallIds.has(toolCallId)) return null;
  const eligibility = resolveToolCallRetryEligibility({
    name,
    status,
    reasonCode: execution?.reasonCode,
    retrySafety: execution?.retrySafety,
  });
  if (!eligibility.eligible) return null;

  const run = async (confirmed: boolean) => {
    setIsRunning(true);
    try {
      const streamErrors: string[] = [];
      await retryToolCallStream(
        { chatId: scope.chatId, messageId: scope.messageId, callId: toolCallId },
        confirmed,
        (chunk) => {
          if (chunk.type === 'error') streamErrors.push(chunk.error);
        }
      );
      for (const message of streamErrors) toast(message, 'error');
    } catch (error) {
      toast(resolveApiErrorMessage(error, t.tools.retry.failed), 'error');
    } finally {
      setIsRunning(false);
      setConfirming(false);
      // The new call is part of the message now, finished or not.
      await queryClient.invalidateQueries({ queryKey: messageKeys.list(scope.chatId) });
    }
  };

  const labels = t.tools.labels as Record<string, string> | undefined;
  const handlePress = () => {
    if (eligibility.confirmation === 'none') void run(false);
    else setConfirming(true);
  };

  return (
    <>
      <Button
        variant="subtle"
        size="sm"
        loading={isRunning && !confirming}
        disabled={isRunning}
        onPointerEnter={retryDialog.preload}
        onFocus={retryDialog.preload}
        onClick={handlePress}
      >
        <RotateCcw size={ICON_SM} aria-hidden="true" />
        {t.tools.retry.action}
      </Button>
      {confirming && (
        <retryDialog.Overlay
          toolLabel={labels?.[name] ?? name}
          args={args}
          outcomeUnknown={execution?.reasonCode === 'outcome_unknown'}
          isPending={isRunning}
          onConfirm={() => void run(true)}
          onCancel={() => setConfirming(false)}
          onLoadFailed={() => setConfirming(false)}
        />
      )}
    </>
  );
}
