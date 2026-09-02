/**
 * The process serving this page: how it was started, where it listens, how
 * long it has been up, and the restart control.
 */

import type { HubHealth, MachineStatus } from '@mangostudio/shared/machine';
import { useI18n } from '@/hooks/use-i18n';
import { CardSectionLabel, TOOL_CARD_SURFACE } from '../../components/ToolCard';
import { formatDuration } from '../../format';
import { hubHealthLabel, launchModeLabel } from '../format';
import { MachineActionButton } from './MachineActionButton';

interface HubProcessCardProps {
  readonly status: MachineStatus;
  readonly isRestarting: boolean;
  readonly onRestart: () => void;
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-on-surface-variant/70">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs text-on-surface">{value}</span>
    </div>
  );
}

const HEALTH_TONE: Record<HubHealth, string> = {
  ok: 'bg-primary/10 text-primary',
  unreachable: 'bg-error/10 text-error',
  unprobed: 'bg-on-surface-variant/10 text-on-surface-variant',
};

export function HubProcessCard({ status, isRestarting, onRestart }: HubProcessCardProps) {
  const { t } = useI18n();
  const m = t.environments.machine;
  const { hub } = status;

  return (
    <section className={`${TOOL_CARD_SURFACE} space-y-4 p-5`} data-testid="machine-hub-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardSectionLabel>{m.hub.title}</CardSectionLabel>
          <p className="font-headline text-lg font-bold text-on-surface">
            {hub.running ? m.hub.running : m.hub.notRunning}
          </p>
        </div>
        {hub.health && (
          <span
            // `unprobed` is not a failure — nothing could be measured — so it
            // reads as neutral rather than as a server that stopped answering.
            className={`rounded-full px-2 py-0.5 text-xs font-bold ${HEALTH_TONE[hub.health]}`}
            data-testid="machine-hub-health"
          >
            {hubHealthLabel(t, hub.health)}
          </span>
        )}
      </div>

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

      <div className="border-t border-outline-variant/15 pt-4">
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
    </section>
  );
}
