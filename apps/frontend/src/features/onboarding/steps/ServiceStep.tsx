/**
 * Whether MangoStudio comes back on its own after a logout or a restart.
 *
 * This step is always about the hub's own computer, never about the machine
 * chosen for chats: a service unit keeps *this* process alive. When the browser
 * is somewhere else — or the platform has no supervisor — the server says so
 * and hands back the command to run instead, which is the only honest thing a
 * remote page can offer.
 *
 * A supervisor that could not be asked is not a supervisor with nothing in it:
 * that state is drawn as its own warning, with the machine page's sentence and
 * the raw line the supervisor printed, never as a definite "Not installed".
 */

import type { MachineStatus } from '@mangostudio/shared/machine';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Spinner } from '@/components/ui/Spinner';
import { CopyLine } from '@/features/environments/components/CopyLine';
import {
  useChangeMachineServiceMutation,
  useMachineStatus,
} from '@/features/environments/machine/queries';
import { useI18n } from '@/hooks/use-i18n';
import { StepFrame } from '../StepFrame';

/**
 * The one-line verdict on the hub's service unit.
 *
 * `error` wins over `installed`, as it does on the machine page: when the
 * supervisor could not be asked, neither "Installed" nor "Not installed" is a
 * thing this page knows.
 */
function ServiceState({ service }: { readonly service: MachineStatus['service'] }) {
  const { t } = useI18n();
  const s = t.onboarding.service;

  if (service.error) {
    return (
      <Callout
        tone="warning"
        title={
          service.errorCode
            ? t.environments.machine.service.errors[service.errorCode]
            : s.unreadable
        }
        data-testid="onboarding-service-state"
        data-installed={service.installed}
      >
        {/* A coded reason has a sentence in every locale; the line beneath is
            whatever the supervisor printed, which no dictionary can hold. */}
        <p className="break-all font-mono text-xs">{service.error}</p>
      </Callout>
    );
  }

  return (
    <Callout
      tone={service.installed ? 'success' : 'neutral'}
      title={service.installed ? s.installed : s.notInstalled}
      data-testid="onboarding-service-state"
      data-installed={service.installed}
    />
  );
}

export function ServiceStep() {
  const { t } = useI18n();
  const s = t.onboarding.service;
  const machine = useMachineStatus();
  const change = useChangeMachineServiceMutation();
  const status = machine.data;
  const install = status?.actions.installService;

  return (
    <StepFrame title={s.title} lead={s.lead} hint={s.hint}>
      {machine.isPending || !status ? (
        <div className="flex justify-center py-6">
          <Spinner size="md" />
        </div>
      ) : (
        <ServiceState service={status.service} />
      )}

      {status && !status.service.installed && install?.available ? (
        <Button
          data-testid="onboarding-install-service"
          loading={change.isPending}
          onClick={() => {
            machine.expectChange();
            change.mutate('install');
          }}
        >
          {change.isPending ? s.installing : s.install}
        </Button>
      ) : null}

      {status && !status.service.installed && install && !install.available ? (
        <div className="space-y-2" data-testid="onboarding-service-refused">
          {/* The machine surface already has a sentence for every refusal
              code, and they are the accurate ones — a terminal owning the
              process is a different fact from a browser on another computer.
              Except one: "see the error above" is the machine page's wording,
              and here the warning above already says it. */}
          {install.reason === 'service-unreadable' ? null : (
            <p className="text-sm text-fg-muted">
              {t.environments.machine.actions.reasons[install.reason ?? 'guard']}
            </p>
          )}
          <CopyLine label={s.commandTitle} value={install.command} />
        </div>
      ) : null}
    </StepFrame>
  );
}
