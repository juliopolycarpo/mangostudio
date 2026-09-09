/**
 * Whether MangoStudio comes back on its own after a logout or a restart.
 *
 * This step is always about the hub's own computer, never about the machine
 * chosen for chats: a service unit keeps *this* process alive. When the browser
 * is somewhere else — or the platform has no supervisor — the server says so
 * and hands back the command to run instead, which is the only honest thing a
 * remote page can offer.
 */

import { Server } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { CopyLine } from '@/features/environments/components/CopyLine';
import {
  useChangeMachineServiceMutation,
  useMachineStatus,
} from '@/features/environments/machine/queries';
import { useI18n } from '@/hooks/use-i18n';
import { StepFrame } from '../StepFrame';

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
        <div
          className="flex items-center gap-3 rounded-2xl border border-outline-variant/20 bg-surface-container-lowest/60 px-4 py-3"
          data-testid="onboarding-service-state"
          data-installed={status.service.installed}
        >
          <Server aria-hidden size={16} className="shrink-0 text-primary" />
          <span className="font-semibold text-on-surface text-sm">
            {status.service.installed ? s.installed : s.notInstalled}
          </span>
        </div>
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
              process is a different fact from a browser on another computer. */}
          <p className="text-on-surface-variant/70 text-sm">
            {install.reason
              ? t.environments.machine.actions.reasons[install.reason]
              : t.environments.machine.actions.reasons.guard}
          </p>
          <CopyLine label={s.commandTitle} value={install.command} />
        </div>
      ) : null}
    </StepFrame>
  );
}
