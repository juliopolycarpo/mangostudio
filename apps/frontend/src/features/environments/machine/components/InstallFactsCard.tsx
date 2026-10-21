/**
 * The install around the hub: the sibling runtime binary it spawns, what the
 * host slot has consented to, and where its files live.
 */

import type { MachineStatus } from '@mangostudio/shared/machine';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { MachineCard, MachineFact, MachineFacts } from './MachineCard';

interface InstallFactsCardProps {
  readonly status: MachineStatus;
}

export function InstallFactsCard({ status }: InstallFactsCardProps) {
  const { t } = useI18n();
  const m = t.environments.machine;
  const { runtimeBinary, hostSlot } = status;

  const runtimeValue =
    runtimeBinary.path === null
      ? m.runtime.notBuilt
      : runtimeBinary.error
        ? `${runtimeBinary.path} — ${runtimeBinary.error}`
        : runtimeBinary.present
          ? `${runtimeBinary.path}${runtimeBinary.version ? ` (${runtimeBinary.version})` : ''}`
          : `${runtimeBinary.path} — ${m.runtime.missing}`;
  // Local has no other runtime, so a binary that is not there is a failure.
  const runtimeSeverity =
    runtimeBinary.path === null || runtimeBinary.error || !runtimeBinary.present
      ? 'fail'
      : runtimeBinary.versionMatches === false
        ? 'warn'
        : undefined;

  return (
    <MachineCard title={m.install.title} testId="machine-install-card">
      {runtimeBinary.versionMatches === false && (
        <Callout tone="warning">{m.runtime.versionMismatch}</Callout>
      )}
      <MachineFacts>
        <MachineFact label={m.runtime.title} value={runtimeValue} severity={runtimeSeverity} />
        <MachineFact
          label={m.hostSlot.title}
          value={
            hostSlot.error
              ? `${hostSlot.directory} — ${hostSlot.error}`
              : hostSlot.present
                ? `${m.hostSlot.profile[hostSlot.profile]} · ${hostSlot.directory}`
                : `${m.hostSlot.profile[hostSlot.profile]} · ${m.hostSlot.absent}`
          }
          severity={hostSlot.error ? 'fail' : undefined}
        />
        <MachineFact label={m.install.home} value={status.homeDir} />
        <MachineFact label={m.install.logsDir} value={status.logsDir} />
        <MachineFact
          label={m.install.configFile}
          value={status.configFile ?? m.install.noConfigFile}
        />
        <MachineFact
          label={m.install.build}
          value={[
            status.platform,
            status.standalone ? m.install.standalone : m.install.sourceCheckout,
            ...(status.container ? [m.install.container] : []),
          ].join(' · ')}
        />
      </MachineFacts>
    </MachineCard>
  );
}
