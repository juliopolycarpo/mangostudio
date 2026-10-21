/**
 * What the apply did, and the way back out of it.
 *
 * Undo is prominent because the realization usually arrives a minute later, not
 * immediately — and `partial: true` is called out loudly, since that is the one
 * case where a failure left writes on disk that compensation could not remove.
 *
 * An apply that spanned machines produced one backup set per machine, so it gets
 * one Undo per machine. There is deliberately no "undo everything" button: each
 * one is a separate conversation with a separate host, any of which can be
 * offline, and a single button that half-worked would be the worst outcome here.
 */

import type { PropagationApply, PropagationUndo } from '@mangostudio/shared/library';
import { Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_MD } from '@/lib/icon-sizes';
import { resourceKeyLabel } from '../format';
import { InlineNote } from './InlineNote';
import { ResultRow, ResultSection } from './ResultList';

interface ResultPanelProps {
  readonly result: PropagationApply | undefined;
  readonly undoResult: PropagationUndo | undefined;
  readonly isUndoing: boolean;
  readonly undoError: unknown;
  readonly environmentName: (environmentId: string) => string;
  readonly onUndo: (environmentId: string, backupId: string) => void;
}

export function ResultPanel({
  result,
  undoResult,
  isUndoing,
  undoError,
  environmentName,
  onUndo,
}: ResultPanelProps) {
  const { t } = useI18n();
  const l = t.library;

  if (!result) return null;

  const rolledBack = result.failed.length > 0 && !result.partial;

  return (
    <div className="space-y-4" data-testid="result-panel" data-partial={result.partial}>
      {result.partial && (
        <Callout tone="danger" title={l.result.partial} data-testid="partial-warning" />
      )}
      {rolledBack && <Callout tone="info" title={l.result.rolledBack} data-testid="rolled-back" />}

      {result.applied.length > 0 && (
        <ResultSection heading={l.result.appliedHeading}>
          {result.applied.map((applied) => (
            <ResultRow
              key={`${applied.environmentId}:${applied.resourceKey}:${applied.locationId}`}
              outcome="done"
              title={resourceKeyLabel(applied.resourceKey, l.kinds)}
              testId="applied-row"
            >
              <span className="block break-all font-mono text-fg-muted text-micro">
                {environmentName(applied.environmentId)} · {applied.destinationPath}
              </span>
              {applied.adaptation && (
                <span className="block text-fg-muted text-xs">
                  {l.adaptation.strategy[applied.adaptation.strategy]}
                  {applied.adaptation.provenance &&
                    ` — ${formatMessage(l.adaptation.provenance, {
                      model: applied.adaptation.provenance.modelId,
                      version: applied.adaptation.provenance.promptVersion,
                    })}`}
                </span>
              )}
              {applied.adaptation?.notes.map((note) => (
                <span
                  key={`${note.code}:${note.field ?? ''}`}
                  className="block text-fg-muted text-xs"
                >
                  {l.adaptation.note[note.code]}
                  {note.field ? ` ${note.field}` : ''} — {note.message}
                </span>
              ))}
            </ResultRow>
          ))}
        </ResultSection>
      )}

      {result.failed.length > 0 && (
        <ResultSection heading={l.result.failedHeading}>
          {result.failed.map((failure) => (
            <ResultRow
              key={`${failure.environmentId}:${failure.resourceKey}:${failure.locationId}`}
              outcome="failed"
              title={resourceKeyLabel(failure.resourceKey, l.kinds)}
              testId="failed-row"
            >
              <span className="block text-fg-muted text-xs">
                {environmentName(failure.environmentId)} — {l.failureReason[failure.reason]}
              </span>
            </ResultRow>
          ))}
        </ResultSection>
      )}

      {result.skipped.length > 0 && (
        <ResultSection heading={l.result.skippedHeading}>
          {result.skipped.map((skipped) => (
            <li
              key={`${skipped.environmentId}:${skipped.resourceKey}:${skipped.locationId ?? ''}`}
              className="text-fg-muted text-sm"
              data-testid="skipped-row"
            >
              {resourceKeyLabel(skipped.resourceKey, l.kinds)} — {l.skipReason[skipped.reason]}
            </li>
          ))}
        </ResultSection>
      )}

      {result.applied.length === 0 && result.failed.length === 0 && (
        <p className="text-fg-muted text-sm">{l.result.none}</p>
      )}

      {result.backups.map((handle) => (
        <div
          key={`${handle.environmentId}:${handle.backupId}`}
          className="space-y-3 rounded-md border border-stroke bg-surface p-4"
          data-testid="backup-handle"
          data-environment-id={handle.environmentId}
        >
          <p className="break-all font-mono text-fg-muted text-micro">
            {environmentName(handle.environmentId)} ·{' '}
            {formatMessage(l.result.backupId, { id: handle.backupId })}
          </p>
          {undoResult?.environmentId === handle.environmentId &&
          undoResult.backupId === handle.backupId ? (
            <div className="space-y-2" data-testid="undo-result">
              <p className="text-fg text-sm">
                {formatMessage(l.result.undone, {
                  restored: String(undoResult.restored.length),
                  removed: String(undoResult.removed.length),
                })}
              </p>
              {undoResult.skipped.length > 0 && (
                <InlineNote tone="info">
                  {formatMessage(l.result.undoSkipped, {
                    count: String(undoResult.skipped.length),
                  })}
                </InlineNote>
              )}
              <ul className="space-y-0.5">
                {undoResult.skipped.map((skipped) => (
                  <li key={skipped.destinationPath} className="text-fg-muted text-xs">
                    {skipped.destinationPath} — {l.result.undoSkipReason[skipped.reason]}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onUndo(handle.environmentId, handle.backupId)}
              loading={isUndoing}
              data-testid="undo-button"
            >
              <Undo2 size={ICON_MD} />
              {isUndoing ? l.result.undoing : l.result.undo}
            </Button>
          )}
          {undoError !== null && undoError !== undefined && (
            <InlineNote tone="danger">{l.result.undoError}</InlineNote>
          )}
        </div>
      ))}
    </div>
  );
}
