/**
 * Runtime install/upgrade status and actions on an environment card.
 *
 * Reads the hub's lifecycle view (health + transport action matrix) and runs
 * WSL installs through the same SSE console the toolchain install surface uses.
 */

import type {
  Environment,
  RuntimeLifecycleAction,
  RuntimeLifecycleView,
} from '@mangostudio/shared/environments';
import { Download, HardDriveDownload, RefreshCw, RotateCcw, Shield } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useInstallStream } from '../hooks/use-install-stream';
import {
  useCancelRuntimeInstallMutation,
  useRuntimeLifecycleQuery,
  useRuntimeSetupMutation,
  useStartRuntimeInstallMutation,
} from '../queries';
import { CopyLine } from './CopyLine';
import { InstallConsole } from './InstallConsole';
import { RuntimeConsentDialog } from './RuntimeConsentDialog';

const ACTION_ICONS: Partial<Record<RuntimeLifecycleAction, typeof Download>> = {
  install: Download,
  reinstall: RotateCcw,
  upgrade: RefreshCw,
  download: HardDriveDownload,
};

/** Actions that put bytes on the target machine, in the order the card shows them. */
const PUSH_ACTIONS = ['install', 'reinstall', 'upgrade'] as const;

interface RuntimeLifecyclePanelProps {
  readonly environment: Environment;
}

export function RuntimeLifecyclePanel({ environment }: RuntimeLifecyclePanelProps) {
  const { t } = useI18n();
  const labels = t.environments.entities.runtime;
  const enabled =
    environment.transportKind === 'wsl' ||
    environment.transportKind === 'ssh' ||
    environment.transportKind === 'websocket' ||
    environment.transportKind === 'http' ||
    environment.transportKind === 'stdio';
  const view = useRuntimeLifecycleQuery(environment.id, enabled);
  const install = useStartRuntimeInstallMutation(environment.id);
  const cancelInstall = useCancelRuntimeInstallMutation(environment.id);
  const setup = useRuntimeSetupMutation(environment.id);
  const [runId, setRunId] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const streamPath = runId
    ? `/api/environments/${encodeURIComponent(environment.id)}/runtime/runs/${encodeURIComponent(runId)}/log`
    : null;
  const stream = useInstallStream({
    runId,
    streamPath,
    onExit: () => {
      void view.refetch();
    },
  });

  const data = view.data;
  const busy =
    install.isPending ||
    setup.isPending ||
    Boolean(
      runId && stream.phase !== 'finished' && stream.phase !== 'failed' && stream.phase !== 'idle'
    );

  if (!enabled) return null;

  if (view.isPending && !data) {
    return (
      <p className="text-[11px] text-on-surface-variant/50" data-testid="runtime-lifecycle-loading">
        {labels.loading}
      </p>
    );
  }

  if (view.isError && !data) {
    return (
      <p className="text-[11px] text-error" role="alert" data-testid="runtime-lifecycle-error">
        {resolveApiErrorMessage(view.error, labels.loadFailed)}
      </p>
    );
  }

  if (!data) return null;

  // Local/in-process and stdio with no actions and no health stay quiet,
  // except when a connected peer has already said it will not enforce
  // containment — that warning is the reason the card exists in that case.
  if (
    data.actions.length === 0 &&
    !data.manualCommands &&
    !data.health &&
    data.enforcesPathPolicy !== false
  ) {
    return null;
  }

  return (
    <div
      className="space-y-2 rounded-lg border border-outline-variant/20 bg-surface-container-lowest/70 px-2.5 py-2"
      data-testid="runtime-lifecycle-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">
          {labels.title}
        </p>
        {data.stale ? (
          <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warning">
            {labels.stale}
          </span>
        ) : null}
      </div>

      <HealthSummary view={data} />

      <UnenforcedContainment view={data} />

      <RuntimeOffer view={data} />

      {data.actions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {data.actions
            .filter(
              (action): action is 'install' | 'reinstall' | 'upgrade' | 'download' =>
                PUSH_ACTIONS.includes(action as (typeof PUSH_ACTIONS)[number]) ||
                action === 'download'
            )
            .map((action) => {
              const Icon = ACTION_ICONS[action] ?? Download;
              return (
                <button
                  key={action}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setActionError(null);
                    void install
                      .mutateAsync(action)
                      .then((result) => setRunId(result.runId))
                      .catch((error) =>
                        setActionError(resolveApiErrorMessage(error, labels.actionFailed))
                      );
                  }}
                  // Staging is the quieter option on purpose: it is what you
                  // reach for after declining the install, not instead of it.
                  className={
                    action === 'download'
                      ? 'inline-flex h-7 items-center gap-1.5 rounded-lg bg-surface-container-high/60 px-2 text-[11px] font-semibold text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:opacity-45'
                      : 'inline-flex h-7 items-center gap-1.5 rounded-lg bg-primary/10 px-2 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/15 disabled:opacity-45'
                  }
                >
                  <Icon size={12} />
                  {labels.actions[action]}
                </button>
              );
            })}
          {data.actions.includes('setup') ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConsentOpen(true)}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-primary/10 px-2 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/15 disabled:opacity-45"
            >
              <Shield size={12} />
              {labels.actions.setup}
            </button>
          ) : null}
        </div>
      ) : null}

      {consentOpen ? (
        <RuntimeConsentDialog
          machineName={environment.name}
          initialProfile={data.health?.profile ?? 'full'}
          initialAllow={data.health?.allow}
          isPending={setup.isPending}
          onCancel={() => setConsentOpen(false)}
          onConfirm={(input) => {
            setActionError(null);
            void setup
              .mutateAsync(input)
              .then(() => {
                setConsentOpen(false);
                void view.refetch();
              })
              .catch((error) => setActionError(resolveApiErrorMessage(error, labels.actionFailed)));
          }}
        />
      ) : null}

      {data.manualCommands ? <ManualCommands view={data} /> : null}

      <StagedRuntime view={data} />

      {actionError ? (
        <p className="text-[11px] text-error" role="alert">
          {actionError}
        </p>
      ) : null}

      {runId ? (
        <InstallConsole
          stream={stream}
          onCancel={() => {
            void cancelInstall.mutateAsync(runId).catch(() => undefined);
            setRunId(null);
          }}
          onClose={() => {
            setRunId(null);
            void view.refetch();
          }}
        />
      ) : null}
    </div>
  );
}

function HealthSummary({ view }: { view: RuntimeLifecycleView }) {
  const { t } = useI18n();
  const labels = t.environments.entities.runtime;
  const health = view.health;
  if (!health) {
    return <p className="text-[11px] text-on-surface-variant/60">{labels.noHealth}</p>;
  }

  const version = health.version ?? health.runtimeVersion;
  const bits = [
    version ? formatMessage(labels.version, { version }) : null,
    health.slot ? formatMessage(labels.slot, { slot: health.slot }) : null,
    health.digest ? formatMessage(labels.digest, { digest: health.digest.slice(0, 15) }) : null,
  ].filter((bit): bit is string => Boolean(bit));

  return <p className="font-mono text-[10px] text-on-surface-variant">{bits.join(' · ')}</p>;
}

/**
 * Says when a connected runtime is too old to enforce the path policy the hub
 * sends it. Nothing renders for a peer that enforces, and nothing renders while
 * disconnected — the field is absent then, and `false` would be an accusation
 * against a machine that has not spoken.
 */
function UnenforcedContainment({ view }: { view: RuntimeLifecycleView }) {
  const { t } = useI18n();
  if (view.enforcesPathPolicy !== false) return null;

  return (
    <p
      className="rounded-lg border border-warning/35 bg-warning/5 px-2 py-1.5 text-[11px] text-on-surface-variant"
      role="status"
      data-testid="runtime-unenforced-containment"
    >
      {t.environments.entities.runtime.unenforcedContainment}
    </p>
  );
}

/**
 * Names the runtime the buttons below would install — or, when there is
 * nothing to install (`allow.update` is false, or SSH targets a custom
 * `remoteRuntimePath` the push helper cannot reach), the runtime a download
 * would cache, in copy that does not imply a hub-managed install.
 *
 * Only shown when there is an offer to describe at all: a card with neither a
 * push nor a download action has nothing this line could name, and the health
 * line already says what is there.
 *
 * A machine that already runs the offered build is told so instead. The push
 * actions stay — a reinstall is still a thing to want — but "install the
 * matching runtime on this machine" read as though one were missing on every
 * healthy, up-to-date card.
 */
function RuntimeOffer({ view }: { view: RuntimeLifecycleView }) {
  const { t } = useI18n();
  const labels = t.environments.entities.runtime.staged;
  const staged = view.stagedRuntime;
  const offersPush = view.actions.some((action) =>
    PUSH_ACTIONS.includes(action as (typeof PUSH_ACTIONS)[number])
  );
  if (!staged) return null;

  if (!offersPush) {
    if (!view.actions.includes('download')) return null;
    return (
      <p className="text-[11px] text-on-surface-variant/80" data-testid="runtime-offer">
        {formatMessage(labels.downloadOffer, {
          version: staged.version,
          platform: staged.platformId,
        })}
      </p>
    );
  }

  // The slot's recorded version first, the running process's second — the same
  // pair the health line prints. Version equality settles this on a rolling
  // channel too: a canary build's version carries its own commit
  // (`…-canary.<sha>`), and it is only the asset *filename* that is reused
  // across builds. A machine that has never reported one has nothing to
  // compare, which is the never-installed case and keeps the offer.
  const installed = view.health ? (view.health.version ?? view.health.runtimeVersion) : null;
  if (installed === staged.version) {
    return (
      <p className="text-[11px] text-on-surface-variant/80" data-testid="runtime-offer-matched">
        {formatMessage(labels.matched, { version: staged.version })}
      </p>
    );
  }

  return (
    <p className="text-[11px] text-on-surface-variant/80" data-testid="runtime-offer">
      {formatMessage(labels.offer, { version: staged.version, platform: staged.platformId })}{' '}
      <span className="text-on-surface-variant/60">{labels.offerHint}</span>
    </p>
  );
}

/**
 * The bytes a declined install leaves behind, and how to check them by hand.
 *
 * Rendered only once something is actually on disk: a path that does not exist
 * yet is not a fact about this machine, and printing it with a checksum command
 * that cannot pass would be worse than saying nothing.
 */
function StagedRuntime({ view }: { view: RuntimeLifecycleView }) {
  const { t } = useI18n();
  const labels = t.environments.entities.runtime.staged;
  const staged = view.stagedRuntime;
  if (!staged?.present) return null;

  return (
    <div className="space-y-2" data-testid="runtime-staged">
      <p className="font-label text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/70">
        {labels.title}
      </p>
      <CopyLine label={labels.path} value={staged.path} />
      <CopyLine label={labels.verify} value={staged.verify} />
    </div>
  );
}

function ManualCommands({ view }: { view: RuntimeLifecycleView }) {
  const { t } = useI18n();
  const labels = t.environments.entities.runtime.manual;
  const commands = view.manualCommands;
  if (!commands) return null;

  return (
    <div className="space-y-2">
      {/* Which build these commands fetch. A machine that has never paired is
          exactly when this block is read, and that is also when the hub has to
          guess — so the guess says so instead of quietly handing out Linux. */}
      <p className="text-[11px] text-on-surface-variant/70" data-testid="manual-platform">
        {formatMessage(commands.platformAssumed ? labels.platformAssumed : labels.platform, {
          platform: commands.platformId,
        })}
      </p>
      {commands.install ? <CopyLine label={labels.install} value={commands.install} /> : null}
      {commands.verify ? <CopyLine label={labels.verify} value={commands.verify} /> : null}
      {commands.setup ? <CopyLine label={labels.setup} value={commands.setup} /> : null}
      {commands.serviceInstall ? (
        <CopyLine label={labels.serviceInstall} value={commands.serviceInstall} />
      ) : null}
    </div>
  );
}
