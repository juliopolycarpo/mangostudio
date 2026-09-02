/**
 * One mutating machine action: a button that confirms first, or — when the
 * API says the page may not do it — the sentence explaining why and the CLI
 * command to type instead. Refusing quietly would leave the user with a
 * greyed button and no way forward.
 */

import type { MachineStatus } from '@mangostudio/shared/machine';
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
  readonly variant?: 'primary' | 'secondary' | 'danger';
  readonly isPending: boolean;
  readonly onConfirm: () => void;
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
  testId,
}: MachineActionButtonProps) {
  const { t } = useI18n();
  const m = t.environments.machine.actions;
  const [confirming, setConfirming] = useState(false);
  const entry = status.actions[action];
  const refusals = actionRefusalLines(t, status, action);

  if (!entry.available) {
    return (
      <div className="space-y-2" data-testid={`${testId}-refused`}>
        {refusals.map((line) => (
          <p key={line} className="text-sm text-on-surface-variant">
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
