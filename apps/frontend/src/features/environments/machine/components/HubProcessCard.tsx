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
import { MachineCard } from './MachineCard';

interface HubProcessCardProps {
  readonly status: MachineStatus;
  readonly isRestarting: boolean;
  readonly onRestart: () => void;
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs text-fg">{value}</span>
    </div>
  );
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
    >
      {hub.running && (
        <div className="space-y-1.5">
          {hub.url && <Row label={m.hub.url} value={hub.url} />}
          {hub.pid !== undefined && <Row label={m.hub.pid} value={String(hub.pid)} />}
          {hub.launch && (
            <Row
              label={m.hub.launchLabel}
              value={
                hub.serviceUnit
                  ? `${launchModeLabel(t, hub.launch)} · ${hub.serviceUnit}`
                  : launchModeLabel(t, hub.launch)
              }
            />
          )}
          {hub.uptimeMs !== undefined && (
            <Row label={m.hub.uptime} value={formatDuration(hub.uptimeMs)} />
          )}
          {hub.version && (
            <Row
              label={m.hub.version}
              value={hub.buildSha ? `${hub.version} (${hub.buildSha.slice(0, 7)})` : hub.version}
            />
          )}
          <Row label={m.hub.logFile} value={hub.logFile || m.hub.noLogFile} />
        </div>
      )}

      <div className="border-t border-stroke pt-4">
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
      </div>
    </MachineCard>
  );
}
