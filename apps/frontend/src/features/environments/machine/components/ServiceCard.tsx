/**
 * The service unit that keeps the hub alive across logout and reboot, and the
 * controls to install or remove it.
 */

import type { MachineStatus } from '@mangostudio/shared/machine';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { supervisorLabel } from '../format';
import { MachineActionButton } from './MachineActionButton';
import { MachineCard } from './MachineCard';

interface ServiceCardProps {
  readonly status: MachineStatus;
  readonly isPending: boolean;
  readonly onInstall: () => void;
  readonly onUninstall: () => void;
}

/** A yes/no fact as a badge: the word carries it, and "no" is neutral rather than red. */
function Flag({
  on,
  yes,
  no,
}: {
  readonly on: boolean;
  readonly yes: string;
  readonly no: string;
}) {
  return <Badge variant={on ? 'success' : 'neutral'}>{on ? yes : no}</Badge>;
}

export function ServiceCard({ status, isPending, onInstall, onUninstall }: ServiceCardProps) {
  const { t } = useI18n();
  const m = t.environments.machine;
  const { service } = status;

  return (
    <MachineCard
      title={m.service.title}
      headline={service.installed ? m.service.installed : m.service.notInstalled}
      description={`${supervisorLabel(t, service.platform)} · ${service.unitName}`}
      testId="machine-service-card"
    >
      <p className="text-sm text-fg-muted">{m.service.description}</p>

      {service.error ? (
        // Coded reasons are ours and have a sentence in every locale; the raw
        // line is whatever the supervisor printed, which no dictionary can
        // hold, so it stays as the diagnostic beneath.
        <Callout
          tone="danger"
          title={service.errorCode ? m.service.errors[service.errorCode] : undefined}
          data-testid="machine-service-error"
        >
          {service.errorCode ? (
            <p className="break-all font-mono text-xs">{service.error}</p>
          ) : (
            service.error
          )}
        </Callout>
      ) : (
        service.installed && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
            <div className="space-y-1">
              <dt className="text-fg-muted">{m.service.enabledLabel}</dt>
              <dd>
                <Flag on={service.enabled} yes={m.service.enabled} no={m.service.disabled} />
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-fg-muted">{m.service.runningLabel}</dt>
              <dd>
                <Flag on={service.running} yes={m.service.running} no={m.service.stopped} />
              </dd>
            </div>
            {service.linger !== undefined && (
              <div className="space-y-1">
                <dt className="text-fg-muted">{m.service.lingerLabel}</dt>
                <dd>
                  <Flag on={service.linger} yes={m.service.lingerOn} no={m.service.lingerOff} />
                </dd>
              </div>
            )}
            {service.execPath && (
              <div className="col-span-full space-y-1">
                <dt className="text-fg-muted">{m.service.runs}</dt>
                <dd className="truncate font-mono text-xs text-fg">{service.execPath}</dd>
              </div>
            )}
          </dl>
        )
      )}

      <div className="border-t border-stroke pt-4">
        {service.installed ? (
          <MachineActionButton
            status={status}
            action="uninstallService"
            label={m.actions.uninstallService}
            confirmTitle={m.actions.confirmUninstallTitle}
            confirmDescription={m.actions.confirmUninstallDescription}
            isPending={isPending}
            onConfirm={onUninstall}
            testId="machine-service-uninstall"
          />
        ) : (
          <MachineActionButton
            status={status}
            action="installService"
            label={m.actions.installService}
            confirmTitle={m.actions.confirmInstallTitle}
            confirmDescription={m.actions.confirmInstallDescription}
            variant="primary"
            isPending={isPending}
            onConfirm={onInstall}
            testId="machine-service-install"
          />
        )}
      </div>
    </MachineCard>
  );
}
