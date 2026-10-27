/**
 * Confirm, then watch, one self-upgrade attempt.
 *
 * Shared by the banner and the machine-page card through `UpdateAction`, so
 * the confirm step, the stream wiring, and the terminal-state rendering live
 * once rather than once per mount site.
 *
 * The progress view has no close control while the stream is live: aborting
 * the `fetch` only stops this tab from watching, it does not stop the
 * install script on the machine, so hiding an in-progress upgrade would make
 * it invisible without making it stop. The dialog stays open until a
 * terminal state, at which point Close is offered.
 */

import type { MachineUpdateStatus } from '@mangostudio/shared/updates';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Dialog } from '@/components/ui/Dialog';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { cn } from '@/lib/utils';

import { machineGuardReasonLabel, upgradeRefusalReasonLabel } from '../format';
import { useUpgradeStream, type UseUpgradeStreamResult } from '../hooks/use-upgrade-stream';
import { invalidateMachineUpdate } from '../queries';
import { RefusalNotice } from './RefusalNotice';

interface UpgradeDialogProps {
  readonly status: MachineUpdateStatus;
  readonly onClose: () => void;
  /** Called once, only when the stream's own report says `outcome: 'upgraded'`. */
  readonly onUpgraded?: () => void;
}

export function UpgradeDialog({ status, onClose, onUpgraded }: UpgradeDialogProps) {
  const { t } = useI18n();
  const m = t.environments.machine.update;
  const queryClient = useQueryClient();
  const stream = useUpgradeStream();
  const [confirmed, setConfirmed] = useState(false);
  const target = status.check?.latestVersion ?? m.dialog.latestUnknown;

  const isTerminal =
    stream.phase === 'done' || stream.phase === 'refused' || stream.phase === 'failed';

  // Fires once per dialog, the moment the stream reaches a terminal state:
  // the banner and card must read the hub's post-attempt answer, and an
  // `upgraded` outcome is the one the mount site cares to react to itself
  // (the machine page raises its own "reconnecting" banner from it).
  const notifiedRef = useRef(false);
  useEffect(() => {
    if (!isTerminal || notifiedRef.current) return;
    notifiedRef.current = true;
    void invalidateMachineUpdate(queryClient);
    if (stream.phase === 'done' && stream.report?.outcome === 'upgraded') {
      onUpgraded?.();
    }
  }, [isTerminal, stream.phase, stream.report, queryClient, onUpgraded]);

  if (!confirmed) {
    return (
      <ConfirmDialog
        title={formatMessage(m.dialog.title, { latest: target })}
        description={m.dialog.description}
        entityName={target}
        confirmLabel={m.upgrade}
        cancelLabel={t.environments.machine.actions.cancel}
        onConfirm={() => {
          setConfirmed(true);
          // No channel here: the server resolves its own effective channel
          // (config's `[updates] channel`, or the build's own) the same way
          // GET /machine/update already reported it as `status.channel`.
          // Sending `installedVia.channel` — the build's own origin, not the
          // configured target — would override the operator's configured
          // channel and could install the wrong one.
          stream.start({});
        }}
        onCancel={onClose}
      />
    );
  }

  return <UpgradeProgress stream={stream} isTerminal={isTerminal} onClose={onClose} />;
}

function UpgradeProgress({
  stream,
  isTerminal,
  onClose,
}: {
  readonly stream: UseUpgradeStreamResult;
  readonly isTerminal: boolean;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const m = t.environments.machine.update;
  const isRunning = stream.phase === 'connecting' || stream.phase === 'streaming';
  const currentStage = stream.stages.at(-1);

  return (
    <Dialog
      ariaLabel={m.upgrade}
      onClose={onClose}
      // While the stream is live there is no way back: aborting the fetch only
      // stops this tab from watching, so Escape and the backdrop wait for a
      // terminal state, as the missing close control does.
      closeDisabled={!isTerminal}
      footer={
        isTerminal ? (
          <Button variant="secondary" onClick={onClose}>
            {t.environments.install.close}
          </Button>
        ) : undefined
      }
    >
      {isRunning && (
        <header className="flex items-center gap-2">
          <Spinner size="sm" />
          <span className="text-sm font-medium text-fg">
            {currentStage ? m.stage[currentStage.stage] : m.stage.resolve}
          </span>
        </header>
      )}

      <div
        className="app-scrollbar max-h-56 overflow-y-auto rounded-md border border-stroke bg-canvas p-3 font-mono text-xs leading-relaxed"
        role="log"
        aria-live="polite"
        data-testid="upgrade-console"
      >
        {stream.lines.length === 0 ? (
          <p className="text-fg-subtle">…</p>
        ) : (
          stream.lines.map((line) => (
            <div
              key={line.id}
              className={cn(
                'whitespace-pre-wrap break-all',
                line.stream === 'stderr' ? 'text-danger' : 'text-fg-muted'
              )}
            >
              {line.text}
            </div>
          ))
        )}
      </div>

      <UpgradeOutcome stream={stream} />
    </Dialog>
  );
}

function UpgradeOutcome({ stream }: { readonly stream: UseUpgradeStreamResult }) {
  const { t } = useI18n();
  const m = t.environments.machine.update;

  if (stream.phase === 'refused' && stream.refusal) {
    // A 403 from the loopback guard (a remote signed-in user clicking
    // Upgrade) carries `reasons` — the guard's own checks — not `reason`,
    // which is this dialog's own refusal enum. Without this fallback the
    // dialog showed neither line: a blank confirm-turned-refusal.
    const reasonLine = stream.refusal.reason
      ? upgradeRefusalReasonLabel(t, stream.refusal.reason)
      : stream.refusal.reasons.length > 0
        ? stream.refusal.reasons.map((reason) => machineGuardReasonLabel(t, reason)).join(' ')
        : t.environments.machine.actions.refused;
    return <RefusalNotice reasonLine={reasonLine} command={stream.refusal.command ?? null} />;
  }

  if (stream.phase === 'failed') {
    return <Callout tone="danger">{stream.streamError ?? m.streamEnded}</Callout>;
  }

  if (stream.phase === 'done' && stream.report) {
    const { report } = stream;
    if (report.outcome === 'upgraded') {
      // Installed is not activated: a foreground hub or a Windows Scheduled
      // Task comes back as `restart: 'manual'` with the old process still
      // serving, and `--no-restart` as `'skipped'`. Showing only the success
      // line reads as finished when it is not, so anything but a scheduled
      // restart turns the notice into a warning.
      return (
        <Callout
          tone={report.restart && report.restart !== 'scheduled' ? 'warning' : 'success'}
          title={formatMessage(m.outcome.upgraded, {
            version: report.target?.version ?? report.currentVersion,
          })}
        >
          {report.restart ? (
            <p data-testid="upgrade-restart-note">{m.outcome.restart[report.restart]}</p>
          ) : null}
        </Callout>
      );
    }
    if (report.outcome === 'already-current') {
      return <Callout tone="success">{m.outcome.alreadyCurrent}</Callout>;
    }
    if (report.outcome === 'refused') {
      return (
        <RefusalNotice
          reasonLine={report.reason ? upgradeRefusalReasonLabel(t, report.reason) : null}
          command={report.command ?? null}
        />
      );
    }
    // `failed`
    return <Callout tone="danger">{report.message ?? m.outcome.failedGeneric}</Callout>;
  }

  return null;
}
