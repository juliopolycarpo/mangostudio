import type { Environment } from '@mangostudio/shared/environments';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-contract';
import { Cable, Check, Pencil, Plus, Server, Trash2, Unplug, X } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Checkbox } from '@/components/ui/Checkbox';
import { Chip } from '@/components/ui/Chip';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FIELD_CLASS } from '@/components/ui/Input';
import { StatusDot } from '@/components/ui/StatusDot';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD } from '@/lib/icon-sizes';
import { cn, resolveApiErrorMessage } from '@/lib/utils';
import { toolchainSummary } from '../format';
import { useRuntimeStatuses } from '../hooks/use-runtime-status';
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
import { EntityPanel } from './EntityPanel';
import { EnvironmentPageState } from './EnvironmentPageState';
import { ENVIRONMENT_STATE_TONE } from './environment-status-tone';
import { InstallTrustToggle } from './InstallTrustToggle';
import { RuntimeLifecyclePanel } from './RuntimeLifecyclePanel';
import { RuntimePairingPanel } from './RuntimePairingPanel';
import { SshPanel } from './SshPanel';
import { TOOL_CARD_SURFACE } from './ToolCard';

export function EnvironmentEntitiesOverview() {
  const { t } = useI18n();
  const environments = useEnvironmentEntitiesQuery();
  const [adding, setAdding] = useState(false);
  const [onboarding, setOnboarding] = useState(false);

  return (
    <section className="space-y-3" data-testid="overview-environments">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold text-fg">{t.environments.entities.title}</h2>
          <p className="text-sm text-fg-muted">{t.environments.entities.description}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
          <Plus size={ICON_MD} />
          {t.environments.entities.add.trigger}
        </Button>
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
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
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
      className={cn(TOOL_CARD_SURFACE, 'space-y-3 p-4')}
      data-testid="environment-entity-card"
      data-environment-id={environment.id}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <Server size={ICON_MD} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden="true" />
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
                  className={FIELD_CLASS}
                />
              </label>
            ) : (
              <h3 className="truncate text-sm font-semibold text-fg">{environment.name}</h3>
            )}
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
              <span>{labels.transport[environment.transportKind]}</span>
              {environment.transportKind === 'container' ? (
                <Badge>{labels.container.badge}</Badge>
              ) : null}
              {environment.virtual ? <span>{labels.virtual}</span> : null}
              {!environment.enabled ? <span>{labels.disabled}</span> : null}
              {environment.status.offlineRuntimeCache ? (
                <Badge className="bg-info-subtle text-info" title={labels.offlineCacheHint}>
                  {labels.offlineCache}
                </Badge>
              ) : null}
            </p>
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-2 text-xs text-fg-muted">
          {/* A binary handoff reads as a live operation, not as the outage it looks like. */}
          <StatusDot
            tone={updating ? 'warning' : ENVIRONMENT_STATE_TONE[state]}
            pulse={updating || state === 'connecting'}
          />
          {updating
            ? labels.status.updating
            : environment.status.pullingImage
              ? labels.status.pulling
              : environment.status.boundElsewhere
                ? labels.status.boundElsewhere
                : labels.status[state]}
        </span>
      </div>

      {environment.status.boundElsewhere ? (
        <Callout tone="warning" data-testid="environment-bound-elsewhere">
          {labels.boundElsewhereHint}
        </Callout>
      ) : null}

      {environment.status.localFailureReason ? (
        <Callout tone="warning" data-testid="local-failure-reason">
          {labels.local.reason[environment.status.localFailureReason]}
        </Callout>
      ) : null}

      <CapabilityChips environment={environment} />

      <ToolchainSummaryLine environment={environment} />

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
        <Callout tone="danger" role="alert">
          {actionError}
        </Callout>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-stroke pt-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void runConnectionAction()}
          disabled={busy || state === 'connecting' || !environment.enabled}
        >
          {state === 'connected' ? <Unplug size={ICON_MD} /> : <Cable size={ICON_MD} />}
          {state === 'connected' ? labels.disconnect : labels.connect}
        </Button>

        {!environment.virtual && editing ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => void saveName()} disabled={busy}>
              <Check size={ICON_MD} />
              {labels.save}
            </Button>
            <Button variant="subtle" size="sm" onClick={cancelEditing} disabled={busy}>
              <X size={ICON_MD} />
              {labels.cancel}
            </Button>
          </>
        ) : null}

        {!environment.virtual && !editing ? (
          <>
            <Button
              variant="subtle"
              size="sm"
              onClick={() => {
                setName(environment.name);
                setEditing(true);
              }}
              disabled={busy}
            >
              <Pencil size={ICON_MD} />
              {labels.edit}
            </Button>
            <Button
              variant="subtle"
              size="sm"
              onClick={() => {
                setRemoveRuntime(false);
                setRemoving(true);
              }}
              disabled={busy}
              className="ml-auto text-danger enabled:hover:bg-danger-subtle"
            >
              <Trash2 size={ICON_MD} />
              {labels.remove}
            </Button>
          </>
        ) : null}
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
            <label className="flex cursor-pointer items-start gap-2 rounded-sm bg-control px-3 py-2 text-left text-sm text-fg">
              <Checkbox
                checked={removeRuntime}
                onChange={(event) => setRemoveRuntime(event.target.checked)}
                className="mt-0.5"
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
 * "Node {version} ({source}) · Bun {version}" for this machine, read off its
 * own runtime statuses.
 *
 * Gated on `connected` for the same reason {@link useEnvironmentHealth} gates
 * its own queries: a card in a grid of many machines must not wake a sleeping
 * remote just by being on screen. Renders nothing rather than a loading state
 * — the line either has an answer or it does not exist yet.
 */
function ToolchainSummaryLine({ environment }: { environment: Environment }) {
  const { t } = useI18n();
  const connected = environment.status.state === 'connected';
  const runtimes = useRuntimeStatuses(environment.id, connected);
  const summary = toolchainSummary(t, runtimes.data);
  if (!summary) return null;

  return (
    <p className="text-xs text-fg-muted" data-testid="environment-toolchain-summary">
      {summary}
    </p>
  );
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
    <Callout tone="warning">
      {formatMessage(t.environments.entities.runtimeVersionDrift, { version: runtimeVersion })}
    </Callout>
  );
}

function CapabilityChips({ environment }: { environment: Environment }) {
  const { t } = useI18n();
  const labels = t.environments.entities;
  const manifest = environment.status.manifest;
  if (!manifest) {
    return <p className="text-xs text-fg-subtle">{labels.noManifest}</p>;
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
    <ul className="flex list-none flex-wrap gap-2" aria-label={labels.description}>
      {chips.map((chip) => (
        <li key={chip}>
          <Chip>{chip}</Chip>
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
    <EntityPanel
      testId="environment-permissions"
      title={labels.title}
      meta={
        <>
          {profile ? <Badge>{labels.profile[profile]}</Badge> : null}
          {stale ? <Badge variant="warning">{t.environments.entities.runtime.stale}</Badge> : null}
        </>
      }
    >
      {denied.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-fg-muted">{labels.deniedIntro}</p>
          <ul className="flex list-none flex-wrap gap-2">
            {denied.map((capability) => {
              const capabilityLabels = t.environments.entities.permissions.capabilities;
              const label =
                capability in capabilityLabels
                  ? capabilityLabels[capability as keyof typeof capabilityLabels]
                  : capability;
              return (
                <li key={capability}>
                  <Chip>{label}</Chip>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <Callout tone="warning">{labels.allowShellHonesty}</Callout>

      <CopyLine label={labels.setupCommand} value={setupCommand} />
    </EntityPanel>
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
