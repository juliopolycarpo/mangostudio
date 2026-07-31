import type { Environment, EnvironmentConnectionState } from '@mangostudio/shared/environments';
import { Cable, Check, Pencil, Server, Trash2, Unplug, X } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { resolveApiErrorMessage } from '@/lib/utils';
import {
  useConnectEnvironmentMutation,
  useDisconnectEnvironmentMutation,
  useEnvironmentEntitiesQuery,
  useRemoveEnvironmentMutation,
  useUpdateEnvironmentMutation,
} from '../queries';
import { EnvironmentPageState } from './EnvironmentPageState';

const STATUS_RAIL: Record<EnvironmentConnectionState, string> = {
  connected: 'bg-primary',
  connecting: 'bg-warning animate-pulse',
  disconnected: 'bg-outline-variant/45',
  error: 'bg-error',
};

export function EnvironmentEntitiesOverview() {
  const { t } = useI18n();
  const environments = useEnvironmentEntitiesQuery();

  return (
    <section className="space-y-3" data-testid="overview-environments">
      <div>
        <h2 className="font-headline text-lg font-bold text-on-surface">
          {t.environments.entities.title}
        </h2>
        <p className="mt-0.5 text-sm text-on-surface-variant/60">
          {t.environments.entities.description}
        </p>
      </div>

      {environments.isPending && !environments.data ? (
        <EnvironmentPageState variant="loading" size="section" />
      ) : environments.isError && !environments.data ? (
        <EnvironmentPageState
          variant="error"
          size="section"
          onRetry={() => void environments.refetch()}
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(environments.data ?? []).map((environment) => (
            <EnvironmentEntityCard key={environment.id} environment={environment} />
          ))}
        </div>
      )}
    </section>
  );
}

function EnvironmentEntityCard({ environment }: { environment: Environment }) {
  const { t } = useI18n();
  const labels = t.environments.entities;
  const connect = useConnectEnvironmentMutation();
  const disconnect = useDisconnectEnvironmentMutation();
  const update = useUpdateEnvironmentMutation();
  const remove = useRemoveEnvironmentMutation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(environment.name);
  const [actionError, setActionError] = useState<string | null>(null);
  const busy = connect.isPending || disconnect.isPending || update.isPending || remove.isPending;
  const state = environment.status.state;

  const runConnectionAction = async () => {
    setActionError(null);
    try {
      if (state === 'connected') {
        await disconnect.mutateAsync(environment.id);
      } else {
        await connect.mutateAsync(environment.id);
      }
    } catch (error) {
      setActionError(resolveApiErrorMessage(error, labels.actionFailed));
    }
  };

  const saveName = async () => {
    const nextName = name.trim();
    if (!nextName || nextName === environment.name) {
      setName(environment.name);
      setEditing(false);
      return;
    }
    setActionError(null);
    try {
      await update.mutateAsync({ id: environment.id, updates: { name: nextName } });
      setEditing(false);
    } catch (error) {
      setActionError(resolveApiErrorMessage(error, labels.updateFailed));
    }
  };

  const cancelEditing = () => {
    setName(environment.name);
    setEditing(false);
  };

  const removeEnvironment = async () => {
    if (!window.confirm(formatMessage(labels.removeConfirm, { name: environment.name }))) {
      return;
    }
    setActionError(null);
    try {
      await remove.mutateAsync(environment.id);
    } catch (error) {
      setActionError(resolveApiErrorMessage(error, labels.removeFailed));
    }
  };

  return (
    <article
      className="relative overflow-hidden rounded-2xl border border-outline-variant/20 bg-surface-container-low p-4 shadow-sm"
      data-testid="environment-entity-card"
      data-environment-id={environment.id}
    >
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${STATUS_RAIL[state]}`} />
      <div className="space-y-3 pl-1">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5 rounded-xl bg-surface-container-high p-2 text-primary">
              <Server size={16} />
            </span>
            <div className="min-w-0">
              {editing ? (
                <label className="block">
                  <span className="sr-only">{labels.nameLabel}</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                      // The field sits outside a form, so Enter and Escape have
                      // to be bound here to reach the Save and Cancel buttons.
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        if (!busy) void saveName();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelEditing();
                      }
                    }}
                    className="h-8 w-full rounded-lg border border-primary/35 bg-surface-container-lowest px-2 text-sm font-semibold text-on-surface outline-none focus:ring-1 focus:ring-primary/25"
                  />
                </label>
              ) : (
                <h3 className="truncate font-headline text-base font-bold text-on-surface">
                  {environment.name}
                </h3>
              )}
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-on-surface-variant/65">
                <span>{labels.transport[environment.transportKind]}</span>
                {environment.virtual ? <span>{labels.virtual}</span> : null}
                {!environment.enabled ? <span>{labels.disabled}</span> : null}
              </p>
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-surface-container-high px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
            {labels.status[state]}
          </span>
        </div>

        <CapabilityChips environment={environment} />

        {actionError ? (
          <p className="text-xs text-error" role="alert">
            {actionError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5 border-t border-outline-variant/15 pt-3">
          <button
            type="button"
            onClick={() => void runConnectionAction()}
            disabled={busy || state === 'connecting' || !environment.enabled}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/15 disabled:opacity-45"
          >
            {state === 'connected' ? <Unplug size={13} /> : <Cable size={13} />}
            {state === 'connected' ? labels.disconnect : labels.connect}
          </button>

          {!environment.virtual && editing ? (
            <>
              <button
                type="button"
                onClick={() => void saveName()}
                disabled={busy}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-primary hover:bg-primary/10 disabled:opacity-45"
              >
                <Check size={13} />
                {labels.save}
              </button>
              <button
                type="button"
                onClick={cancelEditing}
                disabled={busy}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-on-surface-variant hover:bg-surface-container-high disabled:opacity-45"
              >
                <X size={13} />
                {labels.cancel}
              </button>
            </>
          ) : null}

          {!environment.virtual && !editing ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setName(environment.name);
                  setEditing(true);
                }}
                disabled={busy}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface disabled:opacity-45"
              >
                <Pencil size={13} />
                {labels.edit}
              </button>
              <button
                type="button"
                onClick={() => void removeEnvironment()}
                disabled={busy}
                className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-error/80 hover:bg-error/10 hover:text-error disabled:opacity-45"
              >
                <Trash2 size={13} />
                {labels.remove}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function CapabilityChips({ environment }: { environment: Environment }) {
  const { t } = useI18n();
  const labels = t.environments.entities;
  const manifest = environment.status.manifest;
  if (!manifest) {
    return <p className="text-xs text-on-surface-variant/50">{labels.noManifest}</p>;
  }

  const chips = [
    formatMessage(labels.platform, { platform: manifest.platform, arch: manifest.arch }),
    manifest.git.available
      ? formatMessage(labels.git, { version: manifest.git.version ?? '' }).trim()
      : labels.gitUnavailable,
    manifest.shells.length > 0
      ? formatMessage(labels.shells, { shells: manifest.shells.join(', ') })
      : undefined,
    manifest.features.checkpoints ? labels.checkpoints : undefined,
  ].filter((chip): chip is string => Boolean(chip));

  return (
    <ul className="flex list-none flex-wrap gap-1.5" aria-label={labels.description}>
      {chips.map((chip) => (
        <li
          key={chip}
          className="rounded-md border border-outline-variant/15 bg-surface-container-lowest px-2 py-1 font-mono text-[10px] text-on-surface-variant"
        >
          {chip}
        </li>
      ))}
    </ul>
  );
}
