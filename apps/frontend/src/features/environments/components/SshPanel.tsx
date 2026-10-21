/**
 * The SSH half of an environment card: where the hub reaches, what it runs
 * there, and — when a connection failed — which of the several unrelated causes
 * it was.
 *
 * The commands offered here are deliberately the ones a human types. MangoStudio
 * launches ssh in batch mode and cannot answer a prompt, so the first trust
 * decision about a host key has to happen at a terminal; a card that hid that
 * behind a button would be hiding the one step it cannot take.
 */

import type { Environment, SshEnvironmentConfig } from '@mangostudio/shared/environments';
import { DEFAULT_SSH_RUNTIME_PATH, sshPreflightCommands } from '@mangostudio/shared/environments';
import { Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useUpdateEnvironmentMutation } from '../queries';
import { type SshFormFields, sshFormToConfig, validateSshForm } from '../ssh-form';
import { CopyLine } from './CopyLine';
import { CommandGroup, EntityPanel } from './EntityPanel';

interface SshPanelProps {
  readonly environment: Environment;
}

function formStateOf(environment: Environment): SshFormFields {
  const config = environment.config as Partial<SshEnvironmentConfig>;
  return {
    host: typeof config.host === 'string' ? config.host : '',
    user: typeof config.user === 'string' ? config.user : '',
    port: typeof config.port === 'number' ? String(config.port) : '',
    identityFile: typeof config.identityFile === 'string' ? config.identityFile : '',
    remoteRuntimePath: typeof config.remoteRuntimePath === 'string' ? config.remoteRuntimePath : '',
  };
}

export function SshPanel({ environment }: SshPanelProps) {
  const { t } = useI18n();
  const labels = t.environments.entities.ssh;
  const update = useUpdateEnvironmentMutation();
  const stored = formStateOf(environment);
  const [form, setForm] = useState<SshFormFields>(stored);
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Realtime keeps environment rows fresh; an untouched form follows them, and
  // one someone is typing into does not get overwritten mid-edit.
  const storedKey = JSON.stringify(stored);
  useEffect(() => {
    if (!edited) setForm(JSON.parse(storedKey) as SshFormFields);
  }, [edited, storedKey]);

  const config = sshFormToConfig(form);
  const invalid = validateSshForm(form);
  const changed = JSON.stringify(config) !== JSON.stringify(sshFormToConfig(stored));

  const set = (patch: Partial<SshFormFields>): void => {
    setEdited(true);
    setForm((current) => ({ ...current, ...patch }));
  };

  const save = async (): Promise<void> => {
    if (!changed || invalid) return;
    setError(null);
    try {
      await update.mutateAsync({ id: environment.id, updates: { config } });
      setEdited(false);
    } catch (caught) {
      setError(resolveApiErrorMessage(caught, labels.saveFailed));
    }
  };

  return (
    <EntityPanel
      testId="ssh-panel"
      icon={<Terminal size={ICON_MD} />}
      title={labels.title}
      description={labels.description}
    >
      {environment.status.sshFailureReason ? (
        <Callout tone="warning" data-testid="ssh-failure-reason">
          {labels.reason[environment.status.sshFailureReason]}
        </Callout>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          id={`ssh-host-${environment.id}`}
          label={labels.hostLabel}
          value={form.host}
          error={invalid === 'host' ? labels.hostInvalid : undefined}
          onChange={(event) => set({ host: event.target.value })}
        />
        <Input
          id={`ssh-user-${environment.id}`}
          label={`${labels.userLabel} · ${t.environments.entities.add.optional}`}
          value={form.user}
          error={invalid === 'user' ? labels.dashInvalid : undefined}
          onChange={(event) => set({ user: event.target.value })}
        />
        <Input
          id={`ssh-port-${environment.id}`}
          label={`${labels.portLabel} · ${t.environments.entities.add.optional}`}
          inputMode="numeric"
          placeholder="22"
          value={form.port}
          error={invalid === 'port' ? labels.portInvalid : undefined}
          onChange={(event) => set({ port: event.target.value })}
        />
        <Input
          id={`ssh-identity-${environment.id}`}
          label={`${labels.identityFileLabel} · ${t.environments.entities.add.optional}`}
          value={form.identityFile}
          error={invalid === 'identityFile' ? labels.dashInvalid : undefined}
          onChange={(event) => set({ identityFile: event.target.value })}
        />
      </div>

      <div className="space-y-1">
        <Input
          id={`ssh-runtime-path-${environment.id}`}
          label={`${labels.runtimePathLabel} · ${t.environments.entities.add.optional}`}
          placeholder={DEFAULT_SSH_RUNTIME_PATH}
          value={form.remoteRuntimePath}
          error={invalid === 'remoteRuntimePath' ? labels.dashInvalid : undefined}
          onChange={(event) => set({ remoteRuntimePath: event.target.value })}
        />
        <p className="text-xs text-fg-muted">
          {formatMessage(labels.runtimePathHint, { path: DEFAULT_SSH_RUNTIME_PATH })}
        </p>
      </div>

      {error ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}

      <Button
        variant="secondary"
        disabled={!changed || invalid !== null}
        loading={update.isPending}
        onClick={() => void save()}
      >
        {labels.save}
      </Button>

      {config.host ? <SshPreflight config={config} /> : null}
    </EntityPanel>
  );
}

function SshPreflight({ config }: { readonly config: SshEnvironmentConfig }) {
  const { t } = useI18n();
  const labels = t.environments.entities.ssh;
  const preflight = sshPreflightCommands(config);

  return (
    <CommandGroup title={labels.preflightTitle} hint={labels.preflightHint}>
      <CopyLine label={labels.preflightReach} value={preflight.reach} />
      <CopyLine label={labels.preflightRuntime} value={preflight.runtime} />
    </CommandGroup>
  );
}
