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
import { CircleCheck, CircleX, TriangleAlert, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

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
        <p
          className="flex items-start gap-2 rounded-lg border border-error/30 bg-error/5 p-3 text-error text-xs"
          data-testid="partial-warning"
        >
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          {l.result.partial}
        </p>
      )}
      {rolledBack && (
        <p className="text-on-surface-variant text-xs" data-testid="rolled-back">
          {l.result.rolledBack}
        </p>
      )}

      {result.applied.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
            {l.result.appliedHeading}
          </h3>
          <ul className="space-y-1">
            {result.applied.map((applied) => (
              <li
                key={`${applied.environmentId}:${applied.resourceKey}:${applied.locationId}`}
                className="flex items-start gap-2 text-xs"
                data-testid="applied-row"
              >
                <CircleCheck size={12} className="mt-0.5 shrink-0 text-primary" />
                <span className="min-w-0">
                  <span className="text-on-surface">{applied.resourceKey}</span>
                  <span className="block break-all font-mono text-[11px] text-on-surface-variant/60">
                    {environmentName(applied.environmentId)} · {applied.destinationPath}
                  </span>
                  {applied.adaptation && (
                    <span className="block text-[11px] text-tertiary">
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
                      className="block text-[11px] text-on-surface-variant/70"
                    >
                      {l.adaptation.note[note.code]}
                      {note.field ? ` ${note.field}` : ''} — {note.message}
                    </span>
                  ))}
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
                key={`${failure.environmentId}:${failure.resourceKey}:${failure.locationId}`}
                className="flex items-start gap-2 text-xs"
                data-testid="failed-row"
              >
                <CircleX size={12} className="mt-0.5 shrink-0 text-error" />
                <span className="min-w-0">
                  <span className="text-on-surface">{failure.resourceKey}</span>
                  <span className="block text-[11px] text-on-surface-variant/70">
                    {environmentName(failure.environmentId)} — {l.failureReason[failure.reason]}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.skipped.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="font-label font-semibold text-[10px] text-on-surface-variant/70 uppercase tracking-widest">
            {l.result.skippedHeading}
          </h3>
          <ul className="space-y-0.5">
            {result.skipped.map((skipped) => (
              <li
                key={`${skipped.environmentId}:${skipped.resourceKey}:${skipped.locationId ?? ''}`}
                className="text-[11px] text-on-surface-variant/70"
                data-testid="skipped-row"
              >
                {skipped.resourceKey} — {l.skipReason[skipped.reason]}
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.applied.length === 0 && result.failed.length === 0 && (
        <p className="text-on-surface-variant text-xs">{l.result.none}</p>
      )}

      {result.backups.map((handle) => (
        <div
          key={`${handle.environmentId}:${handle.backupId}`}
          className="space-y-2 rounded-lg border border-outline-variant/15 bg-surface-container p-3"
          data-testid="backup-handle"
          data-environment-id={handle.environmentId}
        >
          <p className="break-all font-mono text-[11px] text-on-surface-variant/70">
            {environmentName(handle.environmentId)} ·{' '}
            {formatMessage(l.result.backupId, { id: handle.backupId })}
          </p>
          {undoResult?.environmentId === handle.environmentId &&
          undoResult.backupId === handle.backupId ? (
            <div className="space-y-1" data-testid="undo-result">
              <p className="text-on-surface text-xs">
                {formatMessage(l.result.undone, {
                  restored: String(undoResult.restored.length),
                  removed: String(undoResult.removed.length),
                })}
              </p>
              {undoResult.skipped.length > 0 && (
                <p className="text-[11px] text-tertiary">
                  {formatMessage(l.result.undoSkipped, {
                    count: String(undoResult.skipped.length),
                  })}
                </p>
              )}
              <ul className="space-y-0.5">
                {undoResult.skipped.map((skipped) => (
                  <li
                    key={skipped.destinationPath}
                    className="text-[11px] text-on-surface-variant/60"
                  >
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
              <Undo2 size={13} />
              {isUndoing ? l.result.undoing : l.result.undo}
            </Button>
          )}
          {undoError !== null && undoError !== undefined && (
            <p className="text-error text-[11px]">{l.result.undoError}</p>
          )}
        </div>
      ))}
    </div>
  );
}
