/**
 * The service unit that keeps the hub alive across logout and reboot, and the
 * controls to install or remove it.
 */

import type { MachineStatus } from '@mangostudio/shared/machine';
import type { UserServiceErrorCode } from '@mangostudio/shared/runtime-home';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { supervisorLabel } from '../format';
import { MachineActionButton } from './MachineActionButton';
import { MachineCard, MachineFact, MachineFacts } from './MachineCard';

interface ServiceCardProps {
  readonly status: MachineStatus;
  readonly isPending: boolean;
  readonly onInstall: () => void;
  readonly onUninstall: () => void;
}

/**
 * How loudly each reason the project itself raises should say it. Neither is a
 * fault: the person can fix a session bus that is out of reach (open a desktop
 * session, enable linger), which is a `warning`, and a machine with no systemd
 * is a standing fact about it, which is `info`. Only a line the supervisor
 * printed for itself, with no code, is an actual failure.
 */
const SERVICE_ERROR_TONE = {
  'no-systemd': 'info',
  'no-session-bus': 'warning',
} as const satisfies Record<UserServiceErrorCode, 'info' | 'warning'>;

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
  // The card's own notice says the supervisor could not be asked; the refusal under
  // it would only say so again, in less detail.
  // A neutral word rather than no badge: a card that sometimes has one reads as broken.
  const isOn = !service.error && service.installed && service.running;
  const alreadyStated = service.error ? (['service-unreadable'] as const) : undefined;

  return (
    <MachineCard
      title={m.service.title}
      // A supervisor that could not be asked has not said whether the unit is
      // there, so the headline does not guess; the notice below says why.
      headline={
        service.error
          ? m.service.unknown
          : service.installed
            ? m.service.installed
            : m.service.notInstalled
      }
      description={`${supervisorLabel(t, service.platform)} · ${service.unitName}`}
      action={
        <Badge variant={isOn ? 'success' : 'neutral'} data-testid="machine-service-state">
          {service.error ? m.service.stateUnknown : isOn ? m.service.stateOn : m.service.stateOff}
        </Badge>
      }
      testId="machine-service-card"
      footer={
        service.installed ? (
          <MachineActionButton
            status={status}
            action="uninstallService"
            label={m.actions.uninstallService}
            confirmTitle={m.actions.confirmUninstallTitle}
            confirmDescription={m.actions.confirmUninstallDescription}
            isPending={isPending}
            onConfirm={onUninstall}
            alreadyStated={alreadyStated}
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
            alreadyStated={alreadyStated}
            testId="machine-service-install"
          />
        )
      }
    >
      <p className="text-sm text-fg-muted">{m.service.description}</p>

      {service.error ? (
        // Coded reasons are ours and have a sentence in every locale; the raw
        // line is whatever the supervisor printed, which no dictionary can
        // hold, so it stays as the diagnostic beneath.
        <Callout
          tone={service.errorCode ? SERVICE_ERROR_TONE[service.errorCode] : 'danger'}
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
          <MachineFacts>
            <MachineFact label={m.service.enabledLabel}>
              <Flag on={service.enabled} yes={m.service.enabled} no={m.service.disabled} />
            </MachineFact>
            <MachineFact label={m.service.runningLabel}>
              <Flag on={service.running} yes={m.service.running} no={m.service.stopped} />
            </MachineFact>
            {service.linger !== undefined && (
              <MachineFact label={m.service.lingerLabel}>
                <Flag on={service.linger} yes={m.service.lingerOn} no={m.service.lingerOff} />
              </MachineFact>
            )}
            {service.execPath && (
              <MachineFact label={m.service.runs} value={service.execPath} mono />
            )}
          </MachineFacts>
        )
      )}
    </MachineCard>
  );
}
