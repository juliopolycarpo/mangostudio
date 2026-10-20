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
    <span className={`text-sm font-bold ${on ? 'text-accent-fg' : 'text-fg-muted'}`}>
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
        <p className="text-lg font-bold text-fg">
          {service.installed ? m.service.installed : m.service.notInstalled}
        </p>
        <p className="text-sm text-fg-muted">
          {supervisorLabel(t, service.platform)} · {service.unitName}
        </p>
      </div>

      <p className="text-sm text-fg-muted">{m.service.description}</p>

      {service.error ? (
        <div className="space-y-1" data-testid="machine-service-error">
          {/* Coded reasons are ours and have a sentence in every locale; the
              raw line is whatever the supervisor printed, which no dictionary
              can hold, so it stays as the diagnostic beneath. */}
          {service.errorCode ? (
            <>
              <p className="text-sm text-danger">{m.service.errors[service.errorCode]}</p>
              <p className="font-mono text-xs text-fg-muted">{service.error}</p>
            </>
          ) : (
            <p className="text-sm text-danger">{service.error}</p>
          )}
        </div>
      ) : (
        service.installed && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-fg-muted">{m.service.enabledLabel}</dt>
              <dd>
                <Flag on={service.enabled} yes={m.service.enabled} no={m.service.disabled} />
              </dd>
            </div>
            <div>
              <dt className="text-fg-muted">{m.service.runningLabel}</dt>
              <dd>
                <Flag on={service.running} yes={m.service.running} no={m.service.stopped} />
              </dd>
            </div>
            {service.linger !== undefined && (
              <div>
                <dt className="text-fg-muted">{m.service.lingerLabel}</dt>
                <dd>
                  <Flag on={service.linger} yes={m.service.lingerOn} no={m.service.lingerOff} />
                </dd>
              </div>
            )}
            {service.execPath && (
              <div className="col-span-full">
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
