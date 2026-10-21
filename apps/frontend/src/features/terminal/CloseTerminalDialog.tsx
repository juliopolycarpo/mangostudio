import type { TerminalSession } from '@mangostudio/shared/terminal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useI18n } from '@/hooks/use-i18n';

interface CloseTerminalDialogProps {
  readonly session: TerminalSession;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * The question asked before a terminal session is closed: stopping a session
 * kills its shell and whatever it is running, so every surface that can close
 * one (the chat rail's tab strip, the `/terminal` page's rows) asks it in the
 * same words. The caller owns which session is being closed and the mutation.
 *
 * @example
 * <CloseTerminalDialog session={closing} isPending={mutation.isPending}
 *   onConfirm={confirmClose} onCancel={() => setClosingId(null)} />
 */
export function CloseTerminalDialog({
  session,
  isPending,
  onConfirm,
  onCancel,
}: CloseTerminalDialogProps) {
  const { t } = useI18n();
  return (
    <ConfirmDialog
      title={t.terminal.closeConfirmTitle}
      description={t.terminal.closeConfirmDescription}
      entityName={session.title}
      confirmLabel={t.terminal.closeSession}
      cancelLabel={t.terminal.cancel}
      isPending={isPending}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
