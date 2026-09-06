/**
 * The version line's action: an Upgrade button when the hub can act on
 * itself, or the command to run instead when it cannot. Shared by
 * `UpdateBanner` and `UpdateCard` so the button-or-command choice and the
 * dialog it opens live in one place, not two copies that could drift.
 */

import type { MachineUpdateStatus } from '@mangostudio/shared/updates';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { upgradeRefusalReasonLabel } from '../format';
import { RefusalNotice } from './RefusalNotice';
import { UpgradeDialog } from './UpgradeDialog';

interface UpdateActionProps {
  readonly status: MachineUpdateStatus;
  readonly testId?: string;
  /** Called once, only when the upgrade the dialog ran actually replaced the binary. */
  readonly onUpgraded?: () => void;
}

export function UpdateAction({
  status,
  testId = 'machine-update-action',
  onUpgraded,
}: UpdateActionProps) {
  const { t } = useI18n();
  const m = t.environments.machine.update;
  const [dialogOpen, setDialogOpen] = useState(false);

  if (!status.canUpgrade) {
    return (
      <RefusalNotice
        reasonLine={status.reason ? upgradeRefusalReasonLabel(t, status.reason) : null}
        command={status.command ?? null}
        testId={`${testId}-refused`}
      />
    );
  }

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setDialogOpen(true)} data-testid={testId}>
        {m.upgrade}
      </Button>
      {dialogOpen && (
        <UpgradeDialog
          status={status}
          onClose={() => setDialogOpen(false)}
          onUpgraded={onUpgraded}
        />
      )}
    </>
  );
}
