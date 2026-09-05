/**
 * Self-update facts for the machine page: who owns the running binary, what
 * channel it tracks, and the release checker's last answer — then the same
 * button-or-command action the banner offers.
 */

import type { MachineUpdateStatus } from '@mangostudio/shared/updates';
import { useI18n } from '@/hooks/use-i18n';
import { CardSectionLabel, TOOL_CARD_SURFACE } from '../../components/ToolCard';
import { installedViaManagerLabel, updateLatestLabel } from '../format';
import { UpdateAction } from './UpdateAction';

interface UpdateCardProps {
  readonly status: MachineUpdateStatus;
  /** Called once, only when an upgrade run through this card actually replaced the binary. */
  readonly onUpgraded?: () => void;
}

function Row({
  label,
  value,
  title,
}: {
  readonly label: string;
  readonly value: string;
  /** The release host's own text for a failed check — kept for a hover, not shown as the row's sentence. */
  readonly title?: string;
}) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <div className="min-w-0">
        <p className="text-on-surface-variant/70">{label}</p>
        <p className="break-all font-mono text-xs text-on-surface" title={title}>
          {value}
        </p>
      </div>
    </div>
  );
}

export function UpdateCard({ status, onUpgraded }: UpdateCardProps) {
  const { t } = useI18n();
  const m = t.environments.machine.update;

  return (
    <section className={`${TOOL_CARD_SURFACE} space-y-4 p-5`} data-testid="machine-update-card">
      <CardSectionLabel>{m.title}</CardSectionLabel>
      <div className="space-y-3">
        <Row
          label={m.installedVia}
          value={installedViaManagerLabel(t, status.installedVia.manager)}
        />
        <Row label={m.channel} value={m.channelName[status.channel]} />
        <Row label={m.latest} value={updateLatestLabel(t, status)} title={status.check?.error} />
      </div>
      <div className="border-t border-outline-variant/15 pt-4">
        <UpdateAction status={status} testId="machine-update-card-action" onUpgraded={onUpgraded} />
      </div>
    </section>
  );
}
