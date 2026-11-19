import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

export interface ToolCallRetryDialogProps {
  /** The tool's display label. */
  readonly toolLabel: string;
  readonly args: Record<string, unknown>;
  /** The first run may have taken effect before it stopped. */
  readonly outcomeUnknown: boolean;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * The question a retry asks before it runs anything but a read: which tool, with
 * which arguments, and why running it again is not free. Lazy-loaded by
 * `ToolCallRetryControl`, so the dialog stays out of the transcript's chunk until
 * someone presses Retry.
 *
 * // Usage: <ToolCallRetryDialog toolLabel="Write" args={args} outcomeUnknown={false} … />
 */
export default function ToolCallRetryDialog({
  toolLabel,
  args,
  outcomeUnknown,
  isPending,
  onConfirm,
  onCancel,
}: ToolCallRetryDialogProps) {
  const { t } = useI18n();
  const hasArgs = Object.keys(args).length > 0;
  return (
    <ConfirmDialog
      title={formatMessage(t.tools.retry.confirmTitle, { tool: toolLabel })}
      description={
        outcomeUnknown
          ? t.tools.retry.confirmDescriptionOutcomeUnknown
          : t.tools.retry.confirmDescription
      }
      confirmLabel={isPending ? t.tools.retry.retrying : t.tools.retry.confirmAction}
      cancelLabel={t.tools.retry.cancel}
      isPending={isPending}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <div className="mb-4">
        <MicroLabel>{t.tools.retry.argumentsLabel}</MicroLabel>
        <pre className="app-scrollbar mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-canvas p-3 font-mono text-xs text-fg-muted">
          {hasArgs ? JSON.stringify(args, null, 2) : t.tools.retry.noArguments}
        </pre>
      </div>
    </ConfirmDialog>
  );
}
