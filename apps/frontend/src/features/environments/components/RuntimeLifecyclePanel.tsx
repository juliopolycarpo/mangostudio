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
import { Download, RefreshCw, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { resolveApiErrorMessage } from '@/lib/utils';
import { useInstallStream } from '../hooks/use-install-stream';
import { useRuntimeLifecycleQuery, useStartRuntimeInstallMutation } from '../queries';
import { CopyLine } from './CopyLine';
import { InstallConsole } from './InstallConsole';

const ACTION_ICONS: Partial<Record<RuntimeLifecycleAction, typeof Download>> = {
  install: Download,
  reinstall: RotateCcw,
  upgrade: RefreshCw,
};

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
    environment.transportKind === 'http';
  const view = useRuntimeLifecycleQuery(environment.id, enabled);
  const install = useStartRuntimeInstallMutation(environment.id);
  const [runId, setRunId] = useState<string | null>(null);
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

  // Local/in-process and stdio with no actions and no health stay quiet.
  if (data.actions.length === 0 && !data.manualCommands && !data.health) {
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

      {data.actions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {data.actions
            .filter(
              (action) => action === 'install' || action === 'reinstall' || action === 'upgrade'
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
                      .mutateAsync()
                      .then((result) => setRunId(result.runId))
                      .catch((error) =>
                        setActionError(resolveApiErrorMessage(error, labels.actionFailed))
                      );
                  }}
                  className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-primary/10 px-2 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/15 disabled:opacity-45"
                >
                  <Icon size={12} />
                  {labels.actions[action]}
                </button>
              );
            })}
        </div>
      ) : null}

      {data.manualCommands ? <ManualCommands view={data} /> : null}

      {actionError ? (
        <p className="text-[11px] text-error" role="alert">
          {actionError}
        </p>
      ) : null}

      {runId ? (
        <InstallConsole
          stream={stream}
          onCancel={() => setRunId(null)}
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

function ManualCommands({ view }: { view: RuntimeLifecycleView }) {
  const { t } = useI18n();
  const labels = t.environments.entities.runtime.manual;
  const commands = view.manualCommands;
  if (!commands) return null;

  return (
    <div className="space-y-2">
      {commands.install ? <CopyLine label={labels.install} value={commands.install} /> : null}
      {commands.setup ? <CopyLine label={labels.setup} value={commands.setup} /> : null}
      {commands.serviceInstall ? (
        <CopyLine label={labels.serviceInstall} value={commands.serviceInstall} />
      ) : null}
    </div>
  );
}
