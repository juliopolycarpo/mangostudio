/**
 * The removal flow: choose which copies go → confirm → result, with the backup
 * handle and Undo.
 *
 * A separate wizard from propagation, not a mode of it. Propagation's decision
 * is "which content wins"; this one's is "which copies go", and a single wizard
 * meaning both is a wizard where the destructive path shares a confirm button
 * with the safe one.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { LibraryLocationId, RemovalPreviewRequest } from '@mangostudio/shared/library';
import { X } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
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
  /** Machine the wizard was opened on; it heads the list. */
  readonly environmentId?: string;
  readonly onClose: () => void;
}

const STEP_ORDER: readonly RemovalStep[] = ['locations', 'confirm', 'result'];

export function RemovalWizard({
  resourceKeys,
  locationIds,
  environmentId,
  onClose,
}: RemovalWizardProps) {
  const { t } = useI18n();
  const l = t.library;

  const environmentsQuery = useEnvironmentEntitiesQuery();
  const environments = environmentsQuery.data ?? [];
  const scopeEnvironmentId = environmentId ?? LOCAL_ENVIRONMENT_ID;

  /**
   * Every enabled machine, the current one first.
   *
   * All of them, not just the one being viewed, because the last-copy guard is
   * only honest when it can see every copy: a resource still present on another
   * box is not about to disappear, and a scope that hid that machine would ask
   * for an acknowledgement that misstates what is happening.
   */
  const environmentIds = useMemo(() => {
    const ids = [scopeEnvironmentId];
    for (const environment of environments) {
      if (environment.enabled && !ids.includes(environment.id)) ids.push(environment.id);
    }
    return ids;
  }, [environments, scopeEnvironmentId]);

  const environmentName = useMemo(() => {
    const names = new Map(environments.map((environment) => [environment.id, environment.name]));
    return (id: string) => names.get(id) ?? id;
  }, [environments]);

  const request = useMemo<RemovalPreviewRequest>(
    () => ({
      resourceKeys: [...resourceKeys],
      // Empty until the environments query resolves: `environmentIds` below
      // only reflects the full machine set once it does, and a preview taken
      // before that would let an apply through having seen just this machine —
      // exactly what the last-copy guard above depends on not happening.
      locationIds: environmentsQuery.isSuccess ? [...locationIds] : [],
      environmentIds,
    }),
    [resourceKeys, locationIds, environmentIds, environmentsQuery.isSuccess]
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
  // A rejected apply leaves the draft aimed at a preview the server has already
  // refused. Until a fresh one arrives — which clears both flags — the button
  // can only reproduce the same rejection, so it stays out of reach and the
  // banner's "Preview again" is the only way forward.
  const canRemove =
    pendingAcks.length === 0 &&
    !nothingSelected &&
    !wizard.isApplying &&
    !wizard.isStale &&
    !wizard.needsLastCopyReview;

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

          {/*
            The result panel is checked before any preview state. Removing the
            last copy of a resource makes the next preview 404 — the resource is
            gone — and the apply invalidates the library keys, so gating the
            panel on a healthy preview would replace the backup id and Undo with
            an error exactly when they are the only way back.
          */}
          {wizard.step === 'result' ? (
            <RemovalResultPanel
              environmentName={environmentName}
              result={wizard.result}
              undoResult={wizard.undoResult}
              isUndoing={wizard.isUndoing}
              undoError={wizard.undoError}
              onUndo={wizard.undo}
            />
          ) : !hasLocations ? (
            <LibraryPageState
              variant="empty"
              title={l.removal.noLocations}
              hint={l.removal.noLocationsHint}
            />
          ) : !environmentsQuery.isSuccess ? (
            // The preview request above is deliberately held back until this
            // resolves, so `isPreviewing` is still false here — without this
            // branch that reads as a failed preview instead of one not yet asked.
            <LibraryPageState variant="loading" />
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
              environmentName={environmentName}
              preview={preview}
              draft={wizard.draft}
              onToggle={wizard.toggleLocation}
            />
          ) : (
            <RemovalConfirmStep
              preview={preview}
              draft={wizard.draft}
              onToggleAcknowledgement={wizard.toggleAcknowledgement}
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
