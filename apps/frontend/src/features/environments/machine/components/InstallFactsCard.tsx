/**
 * The install around the hub: the sibling runtime binary it spawns, what the
 * host slot has consented to, and where its files live.
 */

import type { MachineStatus } from '@mangostudio/shared/machine';
import { useI18n } from '@/hooks/use-i18n';
import { FindingIcon } from '../../components/FindingList';
import { CardSectionLabel, TOOL_CARD_SURFACE } from '../../components/ToolCard';

interface InstallFactsCardProps {
  readonly status: MachineStatus;
}

function Fact({
  label,
  value,
  severity,
}: {
  readonly label: string;
  readonly value: string;
  readonly severity?: 'warn' | 'fail';
}) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {severity && <FindingIcon severity={severity} />}
      <div className="min-w-0">
        <p className="text-on-surface-variant/70">{label}</p>
        <p className="break-all font-mono text-xs text-on-surface">{value}</p>
      </div>
    </div>
  );
}

export function InstallFactsCard({ status }: InstallFactsCardProps) {
  const { t } = useI18n();
  const m = t.environments.machine;
  const { runtimeBinary, hostSlot } = status;

  const runtimeValue =
    runtimeBinary.path === null
      ? m.runtime.source
      : runtimeBinary.error
        ? `${runtimeBinary.path} — ${runtimeBinary.error}`
        : runtimeBinary.present
          ? `${runtimeBinary.path}${runtimeBinary.version ? ` (${runtimeBinary.version})` : ''}`
          : `${runtimeBinary.path} — ${m.runtime.missing}`;
  const runtimeSeverity =
    runtimeBinary.path === null
      ? undefined
      : runtimeBinary.error || !runtimeBinary.present
        ? 'fail'
        : runtimeBinary.versionMatches === false
          ? 'warn'
          : undefined;

  return (
    <section className={`${TOOL_CARD_SURFACE} space-y-4 p-5`} data-testid="machine-install-card">
      <CardSectionLabel>{m.install.title}</CardSectionLabel>
      <div className="space-y-3">
        <Fact label={m.runtime.title} value={runtimeValue} severity={runtimeSeverity} />
        {runtimeBinary.versionMatches === false && (
          <p className="text-sm text-warning">{m.runtime.versionMismatch}</p>
        )}
        <Fact
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
        <Fact label={m.install.home} value={status.homeDir} />
        <Fact label={m.install.logsDir} value={status.logsDir} />
        <Fact label={m.install.configFile} value={status.configFile ?? m.install.noConfigFile} />
        <Fact
          label={m.install.build}
          value={[
            status.platform,
            status.standalone ? m.install.standalone : m.install.sourceCheckout,
            ...(status.container ? [m.install.container] : []),
          ].join(' · ')}
        />
      </div>
    </section>
  );
}
