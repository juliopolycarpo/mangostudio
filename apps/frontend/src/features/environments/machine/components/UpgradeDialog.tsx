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
import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useFocusTrap } from '@/hooks/use-focus-trap';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { CopyLine } from '../../components/CopyLine';
import { upgradeRefusalReasonLabel } from '../format';
import { type UseUpgradeStreamResult, useUpgradeStream } from '../hooks/use-upgrade-stream';
import { invalidateMachineUpdate } from '../queries';

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
          stream.start({ channel: status.installedVia.channel });
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
  const dialogRef = useFocusTrap(() => {
    if (isTerminal) onClose();
  });
  const isRunning = stream.phase === 'connecting' || stream.phase === 'streaming';
  const currentStage = stream.stages.at(-1);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={m.upgrade}
        tabIndex={-1}
        className="bg-surface-container-high w-full max-w-md rounded-2xl p-5 sm:p-8 shadow-2xl border border-outline-variant/20 space-y-4 outline-none"
      >
        <header className="flex items-center gap-2">
          <OutcomeIcon phase={stream.phase} outcome={stream.report?.outcome} />
          <span className="text-sm font-semibold text-on-surface">
            {isRunning && currentStage
              ? m.stage[currentStage.stage]
              : isRunning
                ? m.stage.resolve
                : null}
          </span>
        </header>

        <div
          className="max-h-56 overflow-y-auto rounded-xl bg-surface-container-highest p-3 font-mono text-xs leading-relaxed"
          role="log"
          aria-live="polite"
          data-testid="upgrade-console"
        >
          {stream.lines.length === 0 ? (
            <p className="text-on-surface-variant/50">…</p>
          ) : (
            stream.lines.map((line) => (
              <div
                key={line.id}
                className={`whitespace-pre-wrap break-all ${
                  line.stream === 'stderr' ? 'text-error' : 'text-on-surface-variant'
                }`}
              >
                {line.text}
              </div>
            ))
          )}
        </div>

        <UpgradeOutcome stream={stream} />

        {isTerminal && (
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t.environments.install.close}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function UpgradeOutcome({ stream }: { readonly stream: UseUpgradeStreamResult }) {
  const { t } = useI18n();
  const m = t.environments.machine.update;

  if (stream.phase === 'refused' && stream.refusal) {
    const reasonLine = stream.refusal.reason
      ? upgradeRefusalReasonLabel(t, stream.refusal.reason)
      : null;
    return (
      <div className="space-y-2">
        {reasonLine && <p className="text-sm text-on-surface-variant">{reasonLine}</p>}
        {stream.refusal.command && (
          <CopyLine
            label={t.environments.machine.actions.runInstead}
            value={stream.refusal.command}
          />
        )}
      </div>
    );
  }

  if (stream.phase === 'failed') {
    return <p className="text-sm text-error">{stream.streamError ?? m.streamEnded}</p>;
  }

  if (stream.phase === 'done' && stream.report) {
    const { report } = stream;
    if (report.outcome === 'upgraded') {
      return (
        <p className="text-sm text-on-surface">
          {formatMessage(m.outcome.upgraded, {
            version: report.target?.version ?? report.currentVersion,
          })}
        </p>
      );
    }
    if (report.outcome === 'already-current') {
      return <p className="text-sm text-on-surface">{m.outcome.alreadyCurrent}</p>;
    }
    if (report.outcome === 'refused') {
      const reasonLine = report.reason ? upgradeRefusalReasonLabel(t, report.reason) : null;
      return (
        <div className="space-y-2">
          {reasonLine && <p className="text-sm text-on-surface-variant">{reasonLine}</p>}
          {report.command && (
            <CopyLine label={t.environments.machine.actions.runInstead} value={report.command} />
          )}
        </div>
      );
    }
    // `failed`
    return <p className="text-sm text-error">{report.message ?? m.outcome.failedGeneric}</p>;
  }

  return null;
}

function OutcomeIcon({
  phase,
  outcome,
}: {
  readonly phase: UseUpgradeStreamResult['phase'];
  readonly outcome: string | undefined;
}) {
  if (phase === 'connecting' || phase === 'streaming') {
    return <LoaderCircle size={16} className="animate-spin text-primary" />;
  }
  if (phase === 'done' && (outcome === 'upgraded' || outcome === 'already-current')) {
    return <CircleCheck size={16} className="text-primary" />;
  }
  return <CircleX size={16} className="text-error" />;
}
