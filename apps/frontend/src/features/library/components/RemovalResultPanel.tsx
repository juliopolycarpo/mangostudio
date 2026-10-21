/**
 * What the removal did, and the way back out of it.
 *
 * Undo is the most prominent control on the panel because the realization
 * usually arrives a minute later — and for a last-copy removal the backup is
 * the only remaining copy, so the panel says which rows those were.
 */

import type { PropagationUndo, RemovalApply } from '@mangostudio/shared/library';
import { Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD } from '@/lib/icon-sizes';
import { InlineNote } from './InlineNote';
import { ResultRow, ResultSection } from './ResultList';

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
        <Callout tone="danger" title={l.removal.resultPartial} data-testid="partial-warning" />
      )}
      {rolledBack && (
        <Callout tone="info" title={l.removal.resultRolledBack} data-testid="rolled-back" />
      )}

      {result.removed.length > 0 && (
        <ResultSection heading={l.removal.resultRemovedHeading}>
          {result.removed.map((removed) => (
            <ResultRow
              key={`${removed.resourceKey}:${removed.locationId}`}
              outcome="done"
              title={removed.resourceKey}
              testId="removed-row"
            >
              <span className="block break-all font-mono text-fg-muted text-micro">
                {removed.path}
              </span>
              {removed.lastCopy && (
                <InlineNote tone="danger" data-testid="last-copy-removed">
                  {l.removal.resultLastCopy}
                </InlineNote>
              )}
            </ResultRow>
          ))}
        </ResultSection>
      )}

      {result.failed.length > 0 && (
        <ResultSection heading={l.result.failedHeading}>
          {result.failed.map((failure) => (
            <ResultRow
              key={`${failure.resourceKey}:${failure.locationId}`}
              outcome="failed"
              title={failure.resourceKey}
              testId="failed-row"
            >
              <span className="block text-fg-muted text-xs">
                {l.removalFailureReason[failure.reason]}
              </span>
            </ResultRow>
          ))}
        </ResultSection>
      )}

      {unresolved.length > 0 && (
        <ResultSection heading={l.removal.resultKeptHeading}>
          {unresolved.map((kept) => (
            <ResultRow
              key={`${kept.resourceKey}:${kept.locationId}`}
              outcome="kept"
              title={kept.resourceKey}
              testId="kept-row"
            >
              <span className="block text-fg-muted text-xs">
                {l.removalKeptReason[kept.reason]}
              </span>
            </ResultRow>
          ))}
        </ResultSection>
      )}

      {result.removed.length === 0 && result.failed.length === 0 && (
        <p className="text-fg-muted text-sm">{l.removal.resultNone}</p>
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
            className="space-y-3 rounded-md border border-stroke bg-surface p-4"
            data-testid="removal-backup-handle"
            data-environment-id={handle.environmentId}
          >
            <p className="break-all font-mono text-fg-muted text-micro">
              {environmentName(handle.environmentId)} ·{' '}
              {formatMessage(l.result.backupId, { id: handle.backupId })}
            </p>
            {handleUndoResult ? (
              <div className="space-y-2" data-testid="removal-undo-result">
                <p className="text-fg text-sm">
                  {formatMessage(l.result.undone, {
                    restored: String(handleUndoResult.restored.length),
                    removed: String(handleUndoResult.removed.length),
                  })}
                </p>
                {handleUndoResult.skipped.length > 0 && (
                  <InlineNote tone="info">
                    {formatMessage(l.result.undoSkipped, {
                      count: String(handleUndoResult.skipped.length),
                    })}
                  </InlineNote>
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
                <Undo2 size={ICON_MD} />
                {handleIsUndoing ? l.result.undoing : l.removal.restore}
              </Button>
            )}
            {handleUndoError !== null && handleUndoError !== undefined && (
              <InlineNote tone="danger">{l.result.undoError}</InlineNote>
            )}
          </div>
        );
      })}
    </div>
  );
}
