/**
 * The install around the hub: the sibling runtime binary it spawns, what the
 * host slot has consented to, and where its files live.
 */

import type { MachineStatus } from '@mangostudio/shared/machine';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { MachineCard, MachineFact, type MachineFactPart, MachineFacts } from './MachineCard';

interface InstallFactsCardProps {
  readonly status: MachineStatus;
}

export function InstallFactsCard({ status }: InstallFactsCardProps) {
  const { t } = useI18n();
  const m = t.environments.machine;
  const { runtimeBinary, hostSlot } = status;

  // The path and whatever the OS said about it are technical; the words this
  // page adds around them ("not built", "missing", the profile) are prose.
  const runtimeValue: string | readonly MachineFactPart[] =
    runtimeBinary.path === null
      ? m.runtime.notBuilt
      : runtimeBinary.error
        ? [{ text: `${runtimeBinary.path} — ${runtimeBinary.error}`, code: true }]
        : runtimeBinary.present
          ? [
              {
                text: `${runtimeBinary.path}${runtimeBinary.version ? ` (${runtimeBinary.version})` : ''}`,
                code: true,
              },
            ]
          : [{ text: runtimeBinary.path, code: true }, { text: ` — ${m.runtime.missing}` }];
  const hostSlotValue: readonly MachineFactPart[] = hostSlot.error
    ? [{ text: `${hostSlot.directory} — ${hostSlot.error}`, code: true }]
    : [
        { text: `${m.hostSlot.profile[hostSlot.profile]} · ` },
        hostSlot.present ? { text: hostSlot.directory, code: true } : { text: m.hostSlot.absent },
      ];
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
          value={hostSlotValue}
          severity={hostSlot.error ? 'fail' : undefined}
        />
        <MachineFact label={m.install.home} value={status.homeDir} mono />
        <MachineFact label={m.install.logsDir} value={status.logsDir} mono />
        <MachineFact
          label={m.install.configFile}
          value={status.configFile ?? m.install.noConfigFile}
          mono={status.configFile !== null}
        />
        <MachineFact
          label={m.install.build}
          value={[
            { text: status.platform, code: true },
            {
              text: [
                '',
                status.standalone ? m.install.standalone : m.install.sourceCheckout,
                ...(status.container ? [m.install.container] : []),
              ].join(' · '),
            },
          ]}
        />
      </MachineFacts>
    </MachineCard>
  );
}
