/**
 * The propagation flow: resolve conflicts → choose destinations → review →
 * apply, then a result panel with the backup handle and Undo.
 *
 * Each gate is closed for a reason the API also enforces, so the wizard never
 * lets a user spend effort on a request that would be refused: no continuing
 * past an unresolved divergence, no applying with nothing checked, no applying
 * a model-drafted conversion that has not been signed off.
 */

import type { LibraryLocationId, PropagationPreviewRequest } from '@mangostudio/shared/library';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { usePropagation } from '../hooks/use-propagation';
import {
  isNoopApply,
  pendingAcknowledgements,
  unresolvedEntries,
  type WizardStep,
} from '../propagation';
import { libraryLocationsQueryOptions } from '../queries';
import { ConflictStep } from './ConflictStep';
import { DestinationStep } from './DestinationStep';
import { LibraryPageState } from './LibraryPageState';
import { ResultPanel } from './ResultPanel';
import { ReviewStep } from './ReviewStep';

interface PropagationWizardProps {
  readonly resourceKeys: readonly string[];
  readonly locationIds: readonly LibraryLocationId[];
  readonly onClose: () => void;
}

const STEP_ORDER: readonly WizardStep[] = ['conflict', 'destinations', 'review', 'result'];

export function PropagationWizard({ resourceKeys, locationIds, onClose }: PropagationWizardProps) {
  const { t } = useI18n();
  const l = t.library;

  const request = useMemo<PropagationPreviewRequest>(
    () => ({ resourceKeys: [...resourceKeys], targetLocationIds: [...locationIds] }),
    [resourceKeys, locationIds]
  );
  const wizard = usePropagation(request);
  const locationsQuery = useQuery(libraryLocationsQueryOptions());
  const preview = wizard.preview;

  const unresolved = useMemo(
    () => (preview ? unresolvedEntries(preview, wizard.draft) : []),
    [preview, wizard.draft]
  );
  const pendingAcks = useMemo(
    () => (preview ? pendingAcknowledgements(preview, wizard.draft) : []),
    [preview, wizard.draft]
  );

  const stepIndex = STEP_ORDER.indexOf(wizard.step);
  const title =
    resourceKeys.length === 1
      ? formatMessage(l.wizard.titleOne, { resource: resourceKeys[0] })
      : formatMessage(l.wizard.title, { count: String(resourceKeys.length) });

  const canContinue =
    wizard.step === 'conflict'
      ? unresolved.length === 0
      : wizard.step === 'destinations'
        ? wizard.draft.destinations.size > 0
        : false;

  const nothingToDo = preview ? isNoopApply(preview, wizard.draft) : true;
  const canApply = pendingAcks.length === 0 && !nothingToDo && !wizard.isApplying;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6"
      data-testid="propagation-wizard"
    >
      <div className="app-scrollbar flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-outline-variant/15 bg-surface-container-low sm:rounded-2xl">
        <header className="flex items-start justify-between gap-3 border-outline-variant/15 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate font-bold text-on-surface text-sm">{title}</h2>
            <ol className="mt-1 flex flex-wrap gap-x-3 text-[11px]">
              {STEP_ORDER.map((step, index) => (
                <li
                  key={step}
                  className={
                    index === stepIndex
                      ? 'font-semibold text-primary'
                      : index < stepIndex
                        ? 'text-on-surface-variant'
                        : 'text-on-surface-variant/40'
                  }
                >
                  {stepLabel(l, step)}
                </li>
              ))}
            </ol>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={l.wizard.close}
            className="shrink-0 rounded-lg p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          >
            <X size={16} />
          </button>
        </header>

        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {wizard.isStale && (
            <div
              className="mb-3 space-y-2 rounded-lg border border-error/30 bg-error/5 p-3"
              data-testid="stale-preview"
            >
              <p className="text-error text-xs">{l.wizard.stale}</p>
              <Button variant="secondary" size="sm" onClick={wizard.repreview}>
                {l.wizard.restale}
              </Button>
            </div>
          )}

          {wizard.isPreviewing && !preview ? (
            <LibraryPageState variant="loading" />
          ) : wizard.previewError || !preview ? (
            <LibraryPageState
              variant="error"
              title={l.wizard.previewError}
              onRetry={wizard.repreview}
            />
          ) : wizard.step === 'conflict' ? (
            <ConflictStep
              preview={preview}
              draft={wizard.draft}
              unresolved={unresolved}
              onResolve={wizard.setResolution}
            />
          ) : wizard.step === 'destinations' ? (
            <DestinationStep
              preview={preview}
              draft={wizard.draft}
              locations={locationsQuery.data ?? []}
              onToggle={wizard.toggleDestination}
            />
          ) : wizard.step === 'review' ? (
            <ReviewStep
              preview={preview}
              draft={wizard.draft}
              onSelectStrategy={wizard.setStrategy}
              onToggleAcknowledged={wizard.toggleAcknowledgement}
            />
          ) : (
            <ResultPanel
              result={wizard.result}
              undoResult={wizard.undoResult}
              isUndoing={wizard.isUndoing}
              undoError={wizard.undoError}
              onUndo={wizard.undo}
            />
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-outline-variant/15 border-t px-4 py-3">
          <div className="min-w-0 text-[11px] text-error">
            {wizard.step === 'review' && pendingAcks.length > 0 && (
              <span data-testid="acknowledge-required">{l.adaptation.acknowledgeRequired}</span>
            )}
            {wizard.step === 'review' && pendingAcks.length === 0 && nothingToDo && (
              <span data-testid="nothing-to-do">{l.review.nothingToDo}</span>
            )}
            {wizard.applyError !== null && wizard.applyError !== undefined && (
              <span>{l.review.applyError}</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {stepIndex > 0 && wizard.step !== 'result' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => wizard.setStep(STEP_ORDER[stepIndex - 1])}
              >
                {l.wizard.back}
              </Button>
            )}
            {wizard.step === 'result' ? (
              <Button size="sm" onClick={onClose}>
                {l.result.done}
              </Button>
            ) : wizard.step === 'review' ? (
              <Button
                size="sm"
                onClick={wizard.apply}
                disabled={!canApply}
                loading={wizard.isApplying}
                data-testid="apply-button"
              >
                {wizard.isApplying ? l.review.applying : l.review.apply}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => wizard.setStep(STEP_ORDER[stepIndex + 1])}
                disabled={!canContinue}
                data-testid="continue-button"
              >
                {l.wizard.continue}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function stepLabel(l: ReturnType<typeof useI18n>['t']['library'], step: WizardStep): string {
  switch (step) {
    case 'conflict':
      return l.wizard.stepConflict;
    case 'destinations':
      return l.wizard.stepDestinations;
    case 'review':
      return l.wizard.stepReview;
    default:
      return l.wizard.stepResult;
  }
}
