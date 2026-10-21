/**
 * One mutating machine action: a button that confirms first, or — when the
 * API says the page may not do it — the sentence explaining why and the CLI
 * command to type instead. Refusing quietly would leave the user with a
 * greyed button and no way forward.
 *
 * The button that opens the confirmation is never `danger`: that variant is the
 * dialog's own final "yes", and a destructive-looking trigger would say it twice.
 */

import type { MachineActionReason, MachineStatus } from '@mangostudio/shared/machine';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useI18n } from '@/hooks/use-i18n';
import { CopyLine } from '../../components/CopyLine';
import { actionRefusalLines } from '../format';

interface MachineActionButtonProps {
  readonly status: MachineStatus;
  readonly action: keyof Omit<MachineStatus['actions'], 'guard'>;
  readonly label: string;
  readonly confirmTitle: string;
  readonly confirmDescription: string;
  readonly variant?: 'primary' | 'secondary';
  readonly isPending: boolean;
  readonly onConfirm: () => void;
  /**
   * Refusal reasons the card already says in a notice of its own. The command to
   * run instead is still offered; only the sentence that would repeat the notice
   * is left out.
   */
  readonly alreadyStated?: readonly MachineActionReason[];
  readonly testId: string;
}

export function MachineActionButton({
  status,
  action,
  label,
  confirmTitle,
  confirmDescription,
  variant = 'secondary',
  isPending,
  onConfirm,
  alreadyStated,
  testId,
}: MachineActionButtonProps) {
  const { t } = useI18n();
  const m = t.environments.machine.actions;
  const [confirming, setConfirming] = useState(false);
  const entry = status.actions[action];
  const refusals =
    entry.reason && alreadyStated?.includes(entry.reason)
      ? []
      : actionRefusalLines(t, status, action);

  if (!entry.available) {
    return (
      <div className="space-y-2" data-testid={`${testId}-refused`}>
        {refusals.map((line) => (
          <p key={line} className="text-sm text-fg-muted">
            {line}
          </p>
        ))}
        <CopyLine label={m.runInstead} value={entry.command} />
      </div>
    );
  }

  return (
    <>
      <Button
        variant={variant}
        size="sm"
        onClick={() => setConfirming(true)}
        loading={isPending}
        data-testid={testId}
      >
        {label}
      </Button>
      {confirming && (
        <ConfirmDialog
          title={confirmTitle}
          description={confirmDescription}
          entityName={entry.command}
          confirmLabel={m.confirm}
          cancelLabel={m.cancel}
          isPending={isPending}
          onConfirm={() => {
            setConfirming(false);
            onConfirm();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
