import type { Environment, EnvironmentConnectionState } from '@mangostudio/shared/environments';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import { Cable, Check, Pencil, Plus, Server, Trash2, Unplug, X } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { resolveApiErrorMessage } from '@/lib/utils';
import { MachineOnboardingWizard } from '../onboarding/MachineOnboardingWizard';
import {
  useConnectEnvironmentMutation,
  useDisconnectEnvironmentMutation,
  useEnvironmentEntitiesQuery,
  useRemoveEnvironmentMutation,
  useRuntimeLifecycleQuery,
  useRuntimeSlotBytesQuery,
  useUpdateEnvironmentMutation,
} from '../queries';
import { AddEnvironmentDialog } from './AddEnvironmentDialog';
import { ContainerPanel } from './ContainerPanel';
import { CopyLine } from './CopyLine';
import { DirectUrlPanel } from './DirectUrlPanel';
import { EnvironmentPageState } from './EnvironmentPageState';
import { InstallTrustToggle } from './InstallTrustToggle';
import { RuntimeLifecyclePanel } from './RuntimeLifecyclePanel';
import { RuntimePairingPanel } from './RuntimePairingPanel';
import { SshPanel } from './SshPanel';

const STATUS_RAIL: Record<EnvironmentConnectionState, string> = {
  connected: 'bg-primary',
  connecting: 'bg-warning animate-pulse',
  disconnected: 'bg-outline-variant/45',
  error: 'bg-error',
};

/** A binary handoff reads as a live operation, not as the outage it looks like. */
const UPDATING_RAIL = 'bg-warning animate-pulse';

export function EnvironmentEntitiesOverview() {
  const { t } = useI18n();
  const environments = useEnvironmentEntitiesQuery();
  const [adding, setAdding] = useState(false);
  const [onboarding, setOnboarding] = useState(false);

  return (
    <section className="space-y-3" data-testid="overview-environments">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-headline text-lg font-bold text-on-surface">
            {t.environments.entities.title}
          </h2>
          <p className="mt-0.5 text-sm text-on-surface-variant/60">
            {t.environments.entities.description}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/15"
        >
          <Plus size={13} />
          {t.environments.entities.add.trigger}
        </button>
      </div>

      {adding ? (
        <AddEnvironmentDialog
          onClose={() => setAdding(false)}
          onStartOnboarding={() => {
            setAdding(false);
            setOnboarding(true);
          }}
        />
      ) : null}

      {onboarding ? <MachineOnboardingWizard onClose={() => setOnboarding(false)} /> : null}

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
  const [removing, setRemoving] = useState(false);
  const [removeRuntime, setRemoveRuntime] = useState(false);
  const removableRuntime =
    environment.transportKind === 'wsl' || environment.transportKind === 'ssh';
  const slotBytes = useRuntimeSlotBytesQuery(environment.id, removing && removableRuntime);
  const busy = connect.isPending || disconnect.isPending || update.isPending || remove.isPending;
  const state = environment.status.state;
  const updating = environment.status.updating === true;

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
    setActionError(null);
    try {
      await remove.mutateAsync({ id: environment.id, removeRuntime });
      setRemoving(false);
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
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-1 ${updating ? UPDATING_RAIL : STATUS_RAIL[state]}`}
      />
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
                {environment.transportKind === 'container' ? (
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">
                    {labels.container.badge}
                  </span>
                ) : null}
                {environment.virtual ? <span>{labels.virtual}</span> : null}
                {!environment.enabled ? <span>{labels.disabled}</span> : null}
              </p>
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-surface-container-high px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
            {updating
              ? labels.status.updating
              : environment.status.pullingImage
                ? labels.status.pulling
                : labels.status[state]}
          </span>
        </div>

        <CapabilityChips environment={environment} />

        <RuntimeRelease environment={environment} />

        <PermissionsRow environment={environment} />

        <RuntimeLifecyclePanel environment={environment} />

        {environment.transportKind === 'websocket' ? (
          <RuntimePairingPanel environmentId={environment.id} />
        ) : null}

        {environment.transportKind === 'http' ? <DirectUrlPanel environment={environment} /> : null}

        {environment.transportKind === 'ssh' ? <SshPanel environment={environment} /> : null}

        {environment.transportKind === 'container' ? (
          <ContainerPanel environment={environment} />
        ) : null}

        <InstallTrustToggle environment={environment} />

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
                onClick={() => {
                  setRemoveRuntime(false);
                  setRemoving(true);
                }}
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

      {removing ? (
        <ConfirmDialog
          title={labels.removeDialogTitle}
          description={formatMessage(labels.removeConfirm, { name: environment.name })}
          entityName={environment.name}
          confirmLabel={labels.remove}
          cancelLabel={labels.cancel}
          isPending={remove.isPending}
          onCancel={() => setRemoving(false)}
          onConfirm={() => void removeEnvironment()}
        >
          {removableRuntime ? (
            <label className="flex items-start gap-2 rounded-xl bg-surface-container-lowest px-3 py-2 text-left text-sm text-on-surface">
              <input
                type="checkbox"
                checked={removeRuntime}
                onChange={(event) => setRemoveRuntime(event.target.checked)}
                className="mt-1 accent-primary"
              />
              <span>
                {formatMessage(labels.removeRuntimeBytes, {
                  bytes: formatSlotBytes(slotBytes.data ?? null),
                })}
              </span>
            </label>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </article>
  );
}

function formatSlotBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Which release answered on the other end.
 *
 * Only shown once it drifts from the hub's. A runtime the hub spawns is always
 * its own release, so printing a version on every card would be noise; a
 * runtime that dials in is installed on someone else's machine and may sit a
 * release behind, which the hub allows on purpose — and something allowed
 * silently is something nobody fixes.
 */
function RuntimeRelease({ environment }: { environment: Environment }) {
  const { t } = useI18n();
  const { runtimeVersion, runtimeVersionDrift } = environment.status;
  if (!runtimeVersion || !runtimeVersionDrift) return null;

  return (
    <p className="rounded-lg border border-warning/35 bg-warning/5 px-2.5 py-2 text-[11px] text-on-surface-variant">
      {formatMessage(t.environments.entities.runtimeVersionDrift, { version: runtimeVersion })}
    </p>
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

const FEATURE_KEYS = [
  'tools',
  'git',
  'probing',
  'mcp',
  'library',
  'checkpoints',
  'fsRead',
  'fsWrite',
  'shell',
  'update',
] as const satisfies ReadonlyArray<keyof RuntimeCapabilityManifest['features']>;

/**
 * Consent the connected machine recorded. Shown when the profile is narrower
 * than full, or when any feature flag is explicitly false — distinct from the
 * disconnected `noManifest` copy above.
 */
function PermissionsRow({ environment }: { environment: Environment }) {
  const { t } = useI18n();
  const labels = t.environments.entities.permissions;
  const manifest = environment.status.manifest;
  const lifecycle = useRuntimeLifecycleQuery(environment.id, Boolean(manifest));
  if (!manifest) return null;

  const denied = FEATURE_KEYS.filter((key) => isRefused(manifest, key));
  const profile = manifest.profile;
  const narrowed = (profile !== undefined && profile !== 'full') || denied.length > 0;
  if (!narrowed) return null;

  const setupCommand = `mangostudio-runtime setup --slot ${setupSlotFor(environment)}`;
  const stale = lifecycle.data?.stale === true;

  return (
    <div
      className="space-y-2 rounded-lg border border-outline-variant/20 bg-surface-container-lowest/70 px-2.5 py-2"
      data-testid="environment-permissions"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">
          {labels.title}
        </p>
        {profile ? (
          <span className="rounded-md bg-surface-container-high px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-on-surface-variant">
            {labels.profile[profile]}
          </span>
        ) : null}
        {stale ? (
          <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warning">
            {t.environments.entities.runtime.stale}
          </span>
        ) : null}
      </div>

      {denied.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] text-on-surface-variant/70">{labels.deniedIntro}</p>
          <ul className="flex list-none flex-wrap gap-1.5">
            {denied.map((capability) => {
              const capabilityLabels = t.environments.entities.permissions.capabilities;
              const label =
                capability in capabilityLabels
                  ? capabilityLabels[capability as keyof typeof capabilityLabels]
                  : capability;
              return (
                <li
                  key={capability}
                  className="rounded-md border border-outline-variant/20 bg-surface-container-high px-2 py-0.5 font-mono text-[10px] text-on-surface-variant"
                >
                  {label}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <p className="text-[11px] text-on-surface-variant/65">{labels.allowShellHonesty}</p>

      <CopyLine label={labels.setupCommand} value={setupCommand} />
    </div>
  );
}

/**
 * Whether the machine's owner refused a capability, as opposed to the machine
 * not having it. `features` is the intersection of the two, so it cannot tell
 * them apart on its own: a full-consent machine with no git binary reports
 * `features.git === false` and would otherwise be listed here as denied.
 * Peers that predate `allow` have only the intersection to offer.
 */
function isRefused(
  manifest: RuntimeCapabilityManifest,
  key: (typeof FEATURE_KEYS)[number]
): boolean {
  const allow = manifest.allow;
  if (!allow) return manifest.features[key] === false;
  // `tools` is a summary of the allow set rather than a member of it; it is
  // false only when every capability below it already reads as denied.
  return key in allow ? allow[key as keyof typeof allow] === false : false;
}

function setupSlotFor(environment: Environment): 'host' | 'wsl' | 'remote' {
  if (environment.transportKind === 'in-process') return 'host';
  if (environment.transportKind === 'wsl') return 'wsl';
  return 'remote';
}
