/**
 * Step 1 — where the machine is.
 *
 * The same fields and the same validation the add dialog uses, so a value the
 * transport refuses cannot look submitable in one surface and not the other.
 * The preflight line is copyable rather than run for you: connecting once by
 * hand is what puts a host key in `known_hosts`, and the hub deliberately will
 * not make that trust decision on anybody's behalf.
 */

import { sshPreflightCommands } from '@mangostudio/shared/environments';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';
import { CopyLine } from '../components/CopyLine';
import type { SshFormFields } from '../ssh-form';
import { isSshFormUsable, SSH_LEADING_DASH, sshFormToConfig, validateSshForm } from '../ssh-form';
import { StepActions } from './StepActions';

interface ReachStepProps {
  readonly form: SshFormFields;
  readonly onChange: (form: SshFormFields) => void;
  readonly onContinue: () => void;
}

export function ReachStep({ form, onChange, onContinue }: ReachStepProps) {
  const { t } = useI18n();
  const labels = t.environments.onboarding;
  const add = t.environments.entities.add;
  const invalid = validateSshForm(form);
  const config = sshFormToConfig(form);
  const patch = (next: Partial<SshFormFields>) => onChange({ ...form, ...next });

  return (
    <div className="space-y-4" data-testid="onboarding-reach-step">
      <p className="text-on-surface-variant/70 text-xs">{labels.reachIntro}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          id="onboarding-ssh-host"
          label={add.sshHostLabel}
          value={form.host}
          autoFocus
          error={
            form.host.trim().length > 0 && SSH_LEADING_DASH.test(form.host.trim())
              ? add.sshDashInvalid
              : undefined
          }
          onChange={(event) => patch({ host: event.target.value })}
        />
        <Input
          id="onboarding-ssh-user"
          label={`${add.sshUserLabel} · ${add.optional}`}
          value={form.user}
          error={
            form.user.trim().length > 0 && SSH_LEADING_DASH.test(form.user.trim())
              ? add.sshDashInvalid
              : undefined
          }
          onChange={(event) => patch({ user: event.target.value })}
        />
        <Input
          id="onboarding-ssh-port"
          label={`${add.sshPortLabel} · ${add.optional}`}
          inputMode="numeric"
          placeholder="22"
          value={form.port}
          error={form.port.trim().length > 0 && invalid === 'port' ? add.sshPortInvalid : undefined}
          onChange={(event) => patch({ port: event.target.value })}
        />
        <Input
          id="onboarding-ssh-identity"
          label={`${add.sshIdentityFileLabel} · ${add.optional}`}
          value={form.identityFile}
          error={
            form.identityFile.trim().length > 0 && SSH_LEADING_DASH.test(form.identityFile.trim())
              ? add.sshDashInvalid
              : undefined
          }
          onChange={(event) => patch({ identityFile: event.target.value })}
        />
      </div>

      {/* Said here rather than discovered at the push: a Windows target is a
          non-goal of the ssh transport, and finding that out three steps in
          after a platform probe is a worse way to learn it. */}
      <p className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest/60 px-3 py-2.5 text-on-surface-variant/70 text-xs">
        {labels.reachWindows}
      </p>

      {config.host ? (
        <div className="space-y-2 rounded-xl border border-primary/35 bg-primary/5 px-3 py-2.5">
          <p className="text-on-surface-variant/70 text-xs">{add.sshPreflight}</p>
          <CopyLine label={add.sshPreflightReach} value={sshPreflightCommands(config).reach} />
        </div>
      ) : null}

      <StepActions
        continueLabel={labels.continue}
        continueDisabled={!isSshFormUsable(form)}
        onContinue={onContinue}
      />
    </div>
  );
}
