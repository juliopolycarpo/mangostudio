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
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useInstallStream } from '../hooks/use-install-stream';
import {
  useCancelRuntimeInstallMutation,
  useRuntimeLifecycleQuery,
  useRuntimeSetupMutation,
  useStartRuntimeInstallMutation,
} from '../queries';
import { CopyLine } from './CopyLine';
import { EntityPanel } from './EntityPanel';
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
      <p className="text-xs text-fg-subtle" data-testid="runtime-lifecycle-loading">
        {labels.loading}
      </p>
    );
  }

  if (view.isError && !data) {
    return (
      <Callout tone="danger" role="alert" data-testid="runtime-lifecycle-error">
        {resolveApiErrorMessage(view.error, labels.loadFailed)}
      </Callout>
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
    <EntityPanel
      testId="runtime-lifecycle-panel"
      title={labels.title}
      meta={data.stale ? <Badge variant="warning">{labels.stale}</Badge> : null}
    >
      <HealthSummary view={data} />

      <UnenforcedContainment view={data} />

      <RuntimeOffer view={data} />

      {data.actions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {data.actions
            .filter(
              (action): action is 'install' | 'reinstall' | 'upgrade' | 'download' =>
                PUSH_ACTIONS.includes(action as (typeof PUSH_ACTIONS)[number]) ||
                action === 'download'
            )
            .map((action) => {
              const Icon = ACTION_ICONS[action] ?? Download;
              return (
                <Button
                  key={action}
                  type="button"
                  variant={action === 'download' ? 'subtle' : 'secondary'}
                  size="sm"
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
                >
                  <Icon size={ICON_MD} />
                  {labels.actions[action]}
                </Button>
              );
            })}
          {data.actions.includes('setup') ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setConsentOpen(true)}
            >
              <Shield size={ICON_MD} />
              {labels.actions.setup}
            </Button>
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
        <Callout tone="danger" role="alert">
          {actionError}
        </Callout>
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
    </EntityPanel>
  );
}

function HealthSummary({ view }: { view: RuntimeLifecycleView }) {
  const { t } = useI18n();
  const labels = t.environments.entities.runtime;
  const health = view.health;
  if (!health) {
    return <p className="text-xs text-fg-muted">{labels.noHealth}</p>;
  }

  const version = health.version ?? health.runtimeVersion;
  const bits = [
    version ? formatMessage(labels.version, { version }) : null,
    health.slot ? formatMessage(labels.slot, { slot: health.slot }) : null,
    health.digest ? formatMessage(labels.digest, { digest: health.digest.slice(0, 15) }) : null,
    view.implementation
      ? formatMessage(labels.implementation, {
          count: String(view.implementation.methods.length),
          fingerprint: view.implementation.fingerprint.slice(0, 12),
        })
      : null,
  ].filter((bit): bit is string => Boolean(bit));

  return <p className="font-mono text-micro text-fg-muted">{bits.join(' · ')}</p>;
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
    <Callout tone="warning" role="status" data-testid="runtime-unenforced-containment">
      {t.environments.entities.runtime.unenforcedContainment}
    </Callout>
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
      <p className="text-xs text-fg-muted" data-testid="runtime-offer">
        {formatMessage(labels.downloadOffer, {
          version: staged.version,
          platform: staged.platformId,
        })}
      </p>
    );
  }

  // The running process, not the slot config. A live update with a pending
  // restart writes the new version into `health.version` while this process
  // still reports the old `runtimeVersion`, and the confirming line is a claim
  // about what is running now. Version equality still settles a rolling
  // channel: a canary build's version carries its own commit (`…-canary.<sha>`),
  // and it is only the asset *filename* that is reused across builds. A machine
  // that has never reported a process version has nothing to compare, which is
  // the never-installed case and keeps the offer.
  //
  // Health is retained after disconnect, marked stale. A stale report falls
  // through to the offer rather than saying a matching runtime is already there.
  const running = view.health?.runtimeVersion ?? null;
  if (!view.stale && running === staged.version) {
    return (
      <p className="text-xs text-fg-muted" data-testid="runtime-offer-matched">
        {formatMessage(labels.matched, { version: staged.version })}
      </p>
    );
  }

  return (
    <p className="text-xs text-fg-muted" data-testid="runtime-offer">
      {formatMessage(labels.offer, { version: staged.version, platform: staged.platformId })}{' '}
      {labels.offerHint}
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
      <MicroLabel as="p">{labels.title}</MicroLabel>
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
      <p className="text-xs text-fg-muted" data-testid="manual-platform">
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
