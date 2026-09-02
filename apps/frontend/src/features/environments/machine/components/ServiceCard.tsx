/**
 * The service unit that keeps the hub alive across logout and reboot, and the
 * controls to install or remove it.
 */

import type { MachineStatus } from '@mangostudio/shared/machine';
import { useI18n } from '@/hooks/use-i18n';
import { CardSectionLabel, TOOL_CARD_SURFACE } from '../../components/ToolCard';
import { supervisorLabel } from '../format';
import { MachineActionButton } from './MachineActionButton';

interface ServiceCardProps {
  readonly status: MachineStatus;
  readonly isPending: boolean;
  readonly onInstall: () => void;
  readonly onUninstall: () => void;
}

function Flag({
  on,
  yes,
  no,
}: {
  readonly on: boolean;
  readonly yes: string;
  readonly no: string;
}) {
  return (
    <span className={`text-sm font-bold ${on ? 'text-primary' : 'text-on-surface-variant/70'}`}>
      {on ? yes : no}
    </span>
  );
}

export function ServiceCard({ status, isPending, onInstall, onUninstall }: ServiceCardProps) {
  const { t } = useI18n();
  const m = t.environments.machine;
  const { service } = status;

  return (
    <section className={`${TOOL_CARD_SURFACE} space-y-4 p-5`} data-testid="machine-service-card">
      <div>
        <CardSectionLabel>{m.service.title}</CardSectionLabel>
        <p className="font-headline text-lg font-bold text-on-surface">
          {service.installed ? m.service.installed : m.service.notInstalled}
        </p>
        <p className="text-sm text-on-surface-variant/70">
          {supervisorLabel(t, service.platform)} · {service.unitName}
        </p>
      </div>

      <p className="text-sm text-on-surface-variant">{m.service.description}</p>

      {service.error ? (
        <p className="text-sm text-error" data-testid="machine-service-error">
          {service.error}
        </p>
      ) : (
        service.installed && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-on-surface-variant/70">{m.service.enabledLabel}</dt>
              <dd>
                <Flag on={service.enabled} yes={m.service.enabled} no={m.service.disabled} />
              </dd>
            </div>
            <div>
              <dt className="text-on-surface-variant/70">{m.service.runningLabel}</dt>
              <dd>
                <Flag on={service.running} yes={m.service.running} no={m.service.stopped} />
              </dd>
            </div>
            {service.linger !== undefined && (
              <div>
                <dt className="text-on-surface-variant/70">{m.service.lingerLabel}</dt>
                <dd>
                  <Flag on={service.linger} yes={m.service.lingerOn} no={m.service.lingerOff} />
                </dd>
              </div>
            )}
            {service.execPath && (
              <div className="col-span-full">
                <dt className="text-on-surface-variant/70">{m.service.runs}</dt>
                <dd className="truncate font-mono text-xs text-on-surface">{service.execPath}</dd>
              </div>
            )}
          </dl>
        )
      )}

      <div className="border-t border-outline-variant/15 pt-4">
        {service.installed ? (
          <MachineActionButton
            status={status}
            action="uninstallService"
            label={m.actions.uninstallService}
            confirmTitle={m.actions.confirmUninstallTitle}
            confirmDescription={m.actions.confirmUninstallDescription}
            variant="danger"
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
    </section>
  );
}
