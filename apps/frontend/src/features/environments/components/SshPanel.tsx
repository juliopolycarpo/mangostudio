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
import { Input } from '@/components/ui/Input';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useUpdateEnvironmentMutation } from '../queries';
import { CopyLine } from './CopyLine';

/** Mirrors `SshArgumentValueSchema`; the server is still the authority. */
const LEADING_DASH = /^-/;

interface SshPanelProps {
  readonly environment: Environment;
}

interface SshFormState {
  readonly host: string;
  readonly user: string;
  readonly port: string;
  readonly identityFile: string;
  readonly remoteRuntimePath: string;
}

function formStateOf(environment: Environment): SshFormState {
  const config = environment.config as Partial<SshEnvironmentConfig>;
  return {
    host: typeof config.host === 'string' ? config.host : '',
    user: typeof config.user === 'string' ? config.user : '',
    port: typeof config.port === 'number' ? String(config.port) : '',
    identityFile: typeof config.identityFile === 'string' ? config.identityFile : '',
    remoteRuntimePath: typeof config.remoteRuntimePath === 'string' ? config.remoteRuntimePath : '',
  };
}

/** The form as the transport sees it: empty means "not set", never an empty argv entry. */
function toConfig(form: SshFormState): SshEnvironmentConfig {
  // Only a wholly numeric value becomes a port: `Number.parseInt` would
  // silently accept `22abc` as 22 and store something nobody typed.
  const rawPort = form.port.trim();
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  return {
    host: form.host.trim(),
    ...(form.user.trim() ? { user: form.user.trim() } : {}),
    ...(Number.isFinite(port) ? { port } : {}),
    ...(form.identityFile.trim() ? { identityFile: form.identityFile.trim() } : {}),
    ...(form.remoteRuntimePath.trim() ? { remoteRuntimePath: form.remoteRuntimePath.trim() } : {}),
  };
}

export function SshPanel({ environment }: SshPanelProps) {
  const { t } = useI18n();
  const labels = t.environments.entities.ssh;
  const update = useUpdateEnvironmentMutation();
  const stored = formStateOf(environment);
  const [form, setForm] = useState<SshFormState>(stored);
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Realtime keeps environment rows fresh; an untouched form follows them, and
  // one someone is typing into does not get overwritten mid-edit.
  const storedKey = JSON.stringify(stored);
  useEffect(() => {
    if (!edited) setForm(JSON.parse(storedKey) as SshFormState);
  }, [edited, storedKey]);

  const config = toConfig(form);
  const invalid = validate(form);
  const changed = JSON.stringify(config) !== JSON.stringify(toConfig(stored));

  const set = (patch: Partial<SshFormState>): void => {
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
    <section
      className="space-y-3 rounded-xl border border-outline-variant/20 bg-surface-container-lowest/60 p-3"
      data-testid="ssh-panel"
    >
      <div className="flex items-start gap-2">
        <Terminal size={14} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 space-y-0.5">
          <p className="font-semibold text-on-surface text-xs">{labels.title}</p>
          <p className="text-[11px] text-on-surface-variant/70">{labels.description}</p>
        </div>
      </div>

      {environment.status.sshFailureReason ? (
        <p
          className="rounded-lg border border-warning/35 bg-warning/5 px-2.5 py-2 text-[11px] text-on-surface-variant"
          data-testid="ssh-failure-reason"
        >
          {labels.reason[environment.status.sshFailureReason]}
        </p>
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
        <p className="text-[11px] text-on-surface-variant/60">
          {formatMessage(labels.runtimePathHint, { path: DEFAULT_SSH_RUNTIME_PATH })}
        </p>
      </div>

      {error ? (
        <p className="text-[11px] text-error" role="alert">
          {error}
        </p>
      ) : null}

      <Button
        variant="secondary"
        className="h-8 px-2.5 text-xs"
        disabled={!changed || invalid !== null}
        loading={update.isPending}
        onClick={() => void save()}
      >
        {labels.save}
      </Button>

      {config.host ? <SshPreflight config={config} /> : null}
    </section>
  );
}

function SshPreflight({ config }: { readonly config: SshEnvironmentConfig }) {
  const { t } = useI18n();
  const labels = t.environments.entities.ssh;
  const preflight = sshPreflightCommands(config);

  return (
    <div className="space-y-2 rounded-lg border border-primary/35 bg-primary/5 p-2.5">
      <p className="font-semibold text-[11px] text-on-surface">{labels.preflightTitle}</p>
      <p className="text-[11px] text-on-surface-variant/70">{labels.preflightHint}</p>
      <CopyLine label={labels.preflightReach} value={preflight.reach} />
      <CopyLine label={labels.preflightRuntime} value={preflight.runtime} />
    </div>
  );
}

type SshFormField = keyof SshFormState;

/**
 * The one field that must be there, the range a port has, and the shape the
 * transport refuses outright everywhere. A leading dash is caught here rather
 * than only server-side because the value it would become — an ssh option
 * instead of an argument — deserves a message beside the field that produced
 * it.
 */
function validate(form: SshFormState): SshFormField | null {
  const host = form.host.trim();
  if (host.length === 0 || LEADING_DASH.test(host)) return 'host';
  for (const field of ['user', 'identityFile', 'remoteRuntimePath'] as const) {
    if (LEADING_DASH.test(form[field].trim())) return field;
  }
  const port = form.port.trim();
  if (port.length === 0) return null;
  const parsed = Number(port);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? null : 'port';
}
