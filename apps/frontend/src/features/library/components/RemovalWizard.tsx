/**
 * The removal flow: choose which copies go → confirm → result, with the backup
 * handle and Undo.
 *
 * A separate wizard from propagation, not a mode of it. Propagation's decision
 * is "which content wins"; this one's is "which copies go", and a single wizard
 * meaning both is a wizard where the destructive path shares a confirm button
 * with the safe one.
 */

import type { LibraryLocationId, RemovalPreviewRequest } from '@mangostudio/shared/library';
import { X } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { useRemoval } from '../hooks/use-removal';
import { isEmptySelection, pendingAcknowledgements, type RemovalStep } from '../removal';
import { LibraryPageState } from './LibraryPageState';
import { RemovalConfirmStep } from './RemovalConfirmStep';
import { RemovalLocationStep } from './RemovalLocationStep';
import { RemovalResultPanel } from './RemovalResultPanel';

interface RemovalWizardProps {
  readonly resourceKeys: readonly string[];
  readonly locationIds: readonly LibraryLocationId[];
  readonly onClose: () => void;
}

const STEP_ORDER: readonly RemovalStep[] = ['locations', 'confirm', 'result'];

export function RemovalWizard({ resourceKeys, locationIds, onClose }: RemovalWizardProps) {
  const { t } = useI18n();
  const l = t.library;

  const request = useMemo<RemovalPreviewRequest>(
    () => ({ resourceKeys: [...resourceKeys], locationIds: [...locationIds] }),
    [resourceKeys, locationIds]
  );
  const wizard = useRemoval(request);
  const preview = wizard.preview;

  const pendingAcks = useMemo(
    () => (preview ? pendingAcknowledgements(preview, wizard.draft) : []),
    [preview, wizard.draft]
  );
  const nothingSelected = preview ? isEmptySelection(preview, wizard.draft) : true;

  const stepIndex = STEP_ORDER.indexOf(wizard.step);
  const title =
    resourceKeys.length === 1
      ? formatMessage(l.removal.titleOne, { resource: resourceKeys[0] })
      : formatMessage(l.removal.title, { count: String(resourceKeys.length) });

  const hasLocations = locationIds.length > 0;
  const canRemove = pendingAcks.length === 0 && !nothingSelected && !wizard.isApplying;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-6"
      data-testid="removal-wizard"
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
              <p className="text-error text-xs">{l.removal.stale}</p>
              <Button variant="secondary" size="sm" onClick={wizard.repreview}>
                {l.wizard.restale}
              </Button>
            </div>
          )}
          {wizard.needsLastCopyReview && (
            <div
              className="mb-3 space-y-2 rounded-lg border border-error/30 bg-error/5 p-3"
              data-testid="last-copy-refused"
            >
              <p className="text-error text-xs">{l.removal.lastCopyRefused}</p>
              <Button variant="secondary" size="sm" onClick={wizard.repreview}>
                {l.wizard.restale}
              </Button>
            </div>
          )}

          {!hasLocations ? (
            <LibraryPageState
              variant="empty"
              title={l.removal.noLocations}
              hint={l.removal.noLocationsHint}
            />
          ) : wizard.isPreviewing && !preview ? (
            <LibraryPageState variant="loading" />
          ) : wizard.previewError || !preview ? (
            <LibraryPageState
              variant="error"
              title={l.removal.previewError}
              onRetry={wizard.repreview}
            />
          ) : wizard.step === 'locations' ? (
            <RemovalLocationStep
              preview={preview}
              draft={wizard.draft}
              onToggle={wizard.toggleLocation}
            />
          ) : wizard.step === 'confirm' ? (
            <RemovalConfirmStep
              preview={preview}
              draft={wizard.draft}
              onToggleAcknowledgement={wizard.toggleAcknowledgement}
            />
          ) : (
            <RemovalResultPanel
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
            {wizard.step === 'confirm' && pendingAcks.length > 0 && (
              <span data-testid="acknowledge-required">{l.removal.acknowledgeRequired}</span>
            )}
            {nothingSelected && wizard.step !== 'result' && (
              <span data-testid="nothing-selected">{l.removal.nothingSelected}</span>
            )}
            {wizard.applyError !== null && wizard.applyError !== undefined && (
              <span>{l.removal.applyError}</span>
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
            ) : wizard.step === 'confirm' ? (
              <Button
                size="sm"
                variant="danger"
                onClick={wizard.apply}
                disabled={!canRemove}
                loading={wizard.isApplying}
                data-testid="remove-button"
              >
                {wizard.isApplying ? l.removal.removing : l.removal.remove}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => wizard.setStep(STEP_ORDER[stepIndex + 1])}
                disabled={nothingSelected}
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

function stepLabel(l: ReturnType<typeof useI18n>['t']['library'], step: RemovalStep): string {
  switch (step) {
    case 'locations':
      return l.removal.stepLocations;
    case 'confirm':
      return l.removal.stepConfirm;
    default:
      return l.wizard.stepResult;
  }
}
