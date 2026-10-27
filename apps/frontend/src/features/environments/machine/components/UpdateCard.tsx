/**
 * Self-update facts for the machine page: who owns the running binary, what
 * channel it tracks, and the release checker's last answer — then the same
 * button-or-command action the banner offers.
 */

import type { MachineUpdateStatus } from '@mangostudio/shared/updates';

import { useI18n } from '@/hooks/use-i18n';

import { installedViaManagerLabel, updateLatestLabel } from '../format';
import { MachineCard, MachineFact, MachineFacts } from './MachineCard';
import { UpdateAction } from './UpdateAction';

interface UpdateCardProps {
  readonly status: MachineUpdateStatus;
  /** Called once, only when an upgrade run through this card actually replaced the binary. */
  readonly onUpgraded?: () => void;
}

export function UpdateCard({ status, onUpgraded }: UpdateCardProps) {
  const { t } = useI18n();
  const m = t.environments.machine.update;

  return (
    <MachineCard
      title={m.title}
      testId="machine-update-card"
      footer={
        <UpdateAction status={status} testId="machine-update-card-action" onUpgraded={onUpgraded} />
      }
    >
      <MachineFacts>
        <MachineFact
          label={m.installedVia}
          value={installedViaManagerLabel(t, status.installedVia.manager)}
        />
        <MachineFact label={m.channel} value={m.channelName[status.channel]} />
        <MachineFact
          label={m.latest}
          value={updateLatestLabel(t, status)}
          title={status.check?.error}
        />
      </MachineFacts>
    </MachineCard>
  );
}
