/**
 * What the removal did, and the way back out of it.
 *
 * Undo is the most prominent control on the panel because the realization
 * usually arrives a minute later — and for a last-copy removal the backup is
 * the only remaining copy, so the panel says which rows those were.
 */

import type { PropagationUndo, RemovalApply } from '@mangostudio/shared/library';
import { CircleCheck, CircleSlash, CircleX, TriangleAlert, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

interface RemovalResultPanelProps {
  readonly result: RemovalApply | undefined;
  /** One mutation now covers every machine's backup, so lookups are per handle. */
  readonly undoResult: (environmentId: string, backupId: string) => PropagationUndo | undefined;
  readonly isUndoing: (environmentId: string, backupId: string) => boolean;
  readonly undoError: (environmentId: string, backupId: string) => unknown;
  readonly environmentName: (environmentId: string) => string;
  readonly onUndo: (environmentId: string, backupId: string) => void;
}

export function RemovalResultPanel({
  result,
  undoResult,
  isUndoing,
  undoError,
  environmentName,
  onUndo,
}: RemovalResultPanelProps) {
  const { t } = useI18n();
  const l = t.library;

  if (!result) return null;

  const rolledBack = result.failed.length > 0 && !result.partial;
  // Only the copies the apply itself decided about. A location the user
  // unchecked, or one that held nothing, is not news — but a copy the run never
  // reached, or put back on its way out, was shown as scheduled for removal and
  // would otherwise vanish from the report entirely.
  const unresolved = result.kept.filter(
    (kept) => kept.reason === 'not-attempted' || kept.reason === 'rolled-back'
  );

  return (
    <div className="space-y-4" data-testid="removal-result-panel" data-partial={result.partial}>
      {result.partial && (
        <p
          className="flex items-start gap-2 rounded-lg border border-error/30 bg-error/5 p-3 text-error text-xs"
          data-testid="partial-warning"
        >
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          {l.removal.resultPartial}
        </p>
      )}
      {rolledBack && (
        <p className="text-on-surface-variant text-xs" data-testid="rolled-back">
          {l.removal.resultRolledBack}
        </p>
      )}

      {result.removed.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
            {l.removal.resultRemovedHeading}
          </h3>
          <ul className="space-y-1">
            {result.removed.map((removed) => (
              <li
                key={`${removed.resourceKey}:${removed.locationId}`}
                className="flex items-start gap-2 text-xs"
                data-testid="removed-row"
              >
                <CircleCheck size={12} className="mt-0.5 shrink-0 text-primary" />
                <span className="min-w-0">
                  <span className="text-on-surface">{removed.resourceKey}</span>
                  <span className="block break-all font-mono text-[11px] text-on-surface-variant/60">
                    {removed.path}
                  </span>
                  {removed.lastCopy && (
                    <span className="block text-[11px] text-error" data-testid="last-copy-removed">
                      {l.removal.resultLastCopy}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.failed.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="font-label font-semibold text-[10px] text-error uppercase tracking-widest">
            {l.result.failedHeading}
          </h3>
          <ul className="space-y-1">
            {result.failed.map((failure) => (
              <li
                key={`${failure.resourceKey}:${failure.locationId}`}
                className="flex items-start gap-2 text-xs"
                data-testid="failed-row"
              >
                <CircleX size={12} className="mt-0.5 shrink-0 text-error" />
                <span className="min-w-0">
                  <span className="text-on-surface">{failure.resourceKey}</span>
                  <span className="block text-[11px] text-on-surface-variant/70">
                    {l.removalFailureReason[failure.reason]}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unresolved.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
            {l.removal.resultKeptHeading}
          </h3>
          <ul className="space-y-1">
            {unresolved.map((kept) => (
              <li
                key={`${kept.resourceKey}:${kept.locationId}`}
                className="flex items-start gap-2 text-xs"
                data-testid="kept-row"
              >
                <CircleSlash size={12} className="mt-0.5 shrink-0 text-on-surface-variant/60" />
                <span className="min-w-0">
                  <span className="text-on-surface">{kept.resourceKey}</span>
                  <span className="block text-[11px] text-on-surface-variant/70">
                    {l.removalKeptReason[kept.reason]}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.removed.length === 0 && result.failed.length === 0 && (
        <p className="text-on-surface-variant text-xs">{l.removal.resultNone}</p>
      )}

      {/*
        One set per machine, so one restore per machine. A removal's backup is
        the only remaining copy of what it deleted, and a single button that
        restored some machines and not others would be the worst thing this
        panel could offer.
      */}
      {result.backups.map((handle) => {
        const handleUndoResult = undoResult(handle.environmentId, handle.backupId);
        const handleIsUndoing = isUndoing(handle.environmentId, handle.backupId);
        const handleUndoError = undoError(handle.environmentId, handle.backupId);
        return (
          <div
            key={`${handle.environmentId}:${handle.backupId}`}
            className="space-y-2 rounded-lg border border-outline-variant/15 bg-surface-container p-3"
            data-testid="removal-backup-handle"
            data-environment-id={handle.environmentId}
          >
            <p className="break-all font-mono text-[11px] text-on-surface-variant/70">
              {environmentName(handle.environmentId)} ·{' '}
              {formatMessage(l.result.backupId, { id: handle.backupId })}
            </p>
            {handleUndoResult ? (
              <div className="space-y-1" data-testid="removal-undo-result">
                <p className="text-on-surface text-xs">
                  {formatMessage(l.result.undone, {
                    restored: String(handleUndoResult.restored.length),
                    removed: String(handleUndoResult.removed.length),
                  })}
                </p>
                {handleUndoResult.skipped.length > 0 && (
                  <p className="text-[11px] text-tertiary">
                    {formatMessage(l.result.undoSkipped, {
                      count: String(handleUndoResult.skipped.length),
                    })}
                  </p>
                )}
              </div>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onUndo(handle.environmentId, handle.backupId)}
                loading={handleIsUndoing}
                data-testid="removal-undo-button"
              >
                <Undo2 size={13} />
                {handleIsUndoing ? l.result.undoing : l.removal.restore}
              </Button>
            )}
            {handleUndoError !== null && handleUndoError !== undefined && (
              <p className="text-error text-[11px]">{l.result.undoError}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
