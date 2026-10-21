/**
 * The overview's one-line answer about the hub itself: what is serving, how it
 * was started, and whether a service keeps it alive. Reads status only — the
 * doctor and log queries belong to the tab, and so does `useMachineStatus`:
 * this section takes no action, so it has no "waiting for a different process"
 * state to keep and no window timer to run.
 */

import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/Card';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { EnvironmentPageState } from '../../components/EnvironmentPageState';
import { OverviewSection } from '../../components/OverviewSection';
import { HUB_HEALTH_TONE, hubHealthLabel, launchModeLabel } from '../format';
import { machineStatusQueryOptions } from '../queries';

export function OverviewMachineSection() {
  const { t } = useI18n();
  const e = t.environments;
  const status = useQuery(machineStatusQueryOptions());
  const data = status.data;

  return (
    <OverviewSection
      tab="machine"
      to="/environments/machine"
      testId="overview-machine"
      isPending={status.isPending && !data}
      hasError={Boolean(status.error) && !data}
      onRetry={() => void status.refetch()}
    >
      {!data ? null : !data.hub.running ? (
        <EnvironmentPageState variant="empty" size="section" title={e.machine.hub.notRunning} />
      ) : (
        <Card>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="machine-rollup">
            <li className="space-y-0.5">
              <p className="text-base font-semibold text-fg">
                {data.hub.version ?? e.versionUnknown}
              </p>
              <MicroLabel as="p">{e.machine.hub.version}</MicroLabel>
            </li>
            <li className="space-y-0.5">
              <p className="text-base font-semibold text-fg">
                {data.hub.launch ? launchModeLabel(t, data.hub.launch) : '—'}
              </p>
              <MicroLabel as="p">{e.machine.hub.launchLabel}</MicroLabel>
            </li>
            <li className="space-y-0.5">
              <p
                className={cn(
                  'text-base font-semibold',
                  data.service.installed ? 'text-fg' : 'text-fg-muted'
                )}
              >
                {data.service.installed
                  ? e.machine.service.installed
                  : e.machine.service.notInstalled}
              </p>
              <MicroLabel as="p">{e.machine.service.title}</MicroLabel>
            </li>
            <li className="space-y-0.5">
              <p
                className={cn(
                  'text-base font-semibold',
                  data.hub.health ? HUB_HEALTH_TONE[data.hub.health].text : 'text-fg-muted'
                )}
              >
                {data.hub.health ? hubHealthLabel(t, data.hub.health) : '—'}
              </p>
              <MicroLabel as="p">{e.machine.hub.healthLabel}</MicroLabel>
            </li>
          </ul>
        </Card>
      )}
    </OverviewSection>
  );
}
