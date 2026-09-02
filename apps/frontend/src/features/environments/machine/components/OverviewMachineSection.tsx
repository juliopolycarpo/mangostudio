/**
 * The overview's one-line answer about the hub itself: what is serving, how it
 * was started, and whether a service keeps it alive. Reads status only — the
 * doctor and log queries belong to the tab.
 */

import { useI18n } from '@/hooks/use-i18n';
import { EnvironmentPageState } from '../../components/EnvironmentPageState';
import { OverviewSection } from '../../components/OverviewSection';
import { CardSectionLabel, TOOL_CARD_SURFACE } from '../../components/ToolCard';
import { HUB_HEALTH_TONE, hubHealthLabel, launchModeLabel } from '../format';
import { useMachineStatus } from '../queries';

export function OverviewMachineSection() {
  const { t } = useI18n();
  const e = t.environments;
  const status = useMachineStatus();
  const data = status.data;

  return (
    <OverviewSection
      title={e.tabs.machine}
      to="/environments/machine"
      testId="overview-machine"
      isPending={status.isPending && !data}
      hasError={Boolean(status.error) && !data}
      onRetry={() => void status.refetch()}
    >
      {!data ? null : !data.hub.running ? (
        <EnvironmentPageState variant="empty" size="section" title={e.machine.hub.notRunning} />
      ) : (
        <div className={`${TOOL_CARD_SURFACE} p-4`}>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="machine-rollup">
            <li className="space-y-0.5">
              <p className="font-headline text-lg font-bold text-on-surface">
                {data.hub.version ?? e.versionUnknown}
              </p>
              <CardSectionLabel>{e.machine.hub.version}</CardSectionLabel>
            </li>
            <li className="space-y-0.5">
              <p className="font-headline text-lg font-bold text-on-surface">
                {data.hub.launch ? launchModeLabel(t, data.hub.launch) : '—'}
              </p>
              <CardSectionLabel>{e.machine.hub.launchLabel}</CardSectionLabel>
            </li>
            <li className="space-y-0.5">
              <p
                className={`font-headline text-lg font-bold ${data.service.installed ? 'text-primary' : 'text-on-surface-variant'}`}
              >
                {data.service.installed
                  ? e.machine.service.installed
                  : e.machine.service.notInstalled}
              </p>
              <CardSectionLabel>{e.machine.service.title}</CardSectionLabel>
            </li>
            <li className="space-y-0.5">
              <p
                className={`font-headline text-lg font-bold ${data.hub.health ? HUB_HEALTH_TONE[data.hub.health].text : 'text-on-surface-variant'}`}
              >
                {data.hub.health ? hubHealthLabel(t, data.hub.health) : '—'}
              </p>
              <CardSectionLabel>{e.machine.hub.healthLabel}</CardSectionLabel>
            </li>
          </ul>
        </div>
      )}
    </OverviewSection>
  );
}
