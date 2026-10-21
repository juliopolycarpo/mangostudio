/**
 * The process serving this page: how it was started, where it listens, how
 * long it has been up, and the restart control.
 */

import type { MachineStatus } from '@mangostudio/shared/machine';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { formatDuration } from '../../format';
import { HUB_HEALTH_TONE, hubHealthLabel, launchModeLabel } from '../format';
import { MachineActionButton } from './MachineActionButton';
import { MachineCard, MachineFact, MachineFacts } from './MachineCard';

interface HubProcessCardProps {
  readonly status: MachineStatus;
  readonly isRestarting: boolean;
  readonly onRestart: () => void;
}

export function HubProcessCard({ status, isRestarting, onRestart }: HubProcessCardProps) {
  const { t } = useI18n();
  const m = t.environments.machine;
  const { hub } = status;

  return (
    <MachineCard
      title={m.hub.title}
      headline={hub.running ? m.hub.running : m.hub.notRunning}
      action={
        hub.health ? (
          <Badge variant={HUB_HEALTH_TONE[hub.health].badge} data-testid="machine-hub-health">
            {hubHealthLabel(t, hub.health)}
          </Badge>
        ) : null
      }
      testId="machine-hub-card"
      footer={
        <MachineActionButton
          status={status}
          action="restart"
          label={m.actions.restart}
          confirmTitle={m.actions.confirmRestartTitle}
          confirmDescription={m.actions.confirmRestartDescription}
          isPending={isRestarting}
          onConfirm={onRestart}
          testId="machine-restart"
        />
      }
    >
      {hub.running && (
        <MachineFacts>
          {hub.url && <MachineFact label={m.hub.url} value={hub.url} />}
          {hub.pid !== undefined && <MachineFact label={m.hub.pid} value={String(hub.pid)} />}
          {hub.launch && (
            <MachineFact
              label={m.hub.launchLabel}
              value={
                hub.serviceUnit
                  ? `${launchModeLabel(t, hub.launch)} · ${hub.serviceUnit}`
                  : launchModeLabel(t, hub.launch)
              }
            />
          )}
          {hub.uptimeMs !== undefined && (
            <MachineFact label={m.hub.uptime} value={formatDuration(hub.uptimeMs)} />
          )}
          {hub.version && (
            <MachineFact
              label={m.hub.version}
              value={hub.buildSha ? `${hub.version} (${hub.buildSha.slice(0, 7)})` : hub.version}
            />
          )}
          <MachineFact label={m.hub.logFile} value={hub.logFile || m.hub.noLogFile} />
        </MachineFacts>
      )}
    </MachineCard>
  );
}
