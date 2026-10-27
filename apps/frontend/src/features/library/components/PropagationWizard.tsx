/**
 * The propagation flow: resolve conflicts → choose destinations → review →
 * apply, then a result panel with the backup handle and Undo. The first step is
 * only a step when something diverges; with one readable version of everything
 * there is nothing to resolve, and the flow opens on the destinations.
 *
 * Each gate is closed for a reason the API also enforces, so the wizard never
 * lets a user spend effort on a request that would be refused: no continuing
 * past an unresolved divergence, no applying with nothing checked, no applying
 * a model-drafted conversion that has not been signed off.
 *
 * The preview spans every machine the user has that can answer, because the
 * destination step has to be able to *offer* a machine before it can be picked —
 * and a machine that is asleep is shown unselectable with its reason rather than
 * left out, which would read as not having it at all.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments/values';
import type { LibraryLocationId, PropagationPreviewRequest } from '@mangostudio/shared/library';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { useEnvironmentEntitiesQuery } from '@/features/environments/queries';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

import { resourceTitle } from '../format';
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
import { InlineNote } from './InlineNote';
import { LibraryPageState } from './LibraryPageState';
import { ResultPanel } from './ResultPanel';
import { ReviewStep } from './ReviewStep';
import { WizardFrame } from './WizardFrame';

const EMPTY_ENVIRONMENTS = [] as const;

interface PropagationWizardProps {
  readonly resourceKeys: readonly string[];
  readonly locationIds: readonly LibraryLocationId[];
  /** Machine the wizard was opened on; its locations are the ones already loaded. */
  readonly environmentId?: string;
  readonly onClose: () => void;
}

const STEPS_WITH_CONFLICTS: readonly WizardStep[] = [
  'conflict',
  'destinations',
  'review',
  'result',
];
const STEPS_WITHOUT_CONFLICTS: readonly WizardStep[] = ['destinations', 'review', 'result'];

export function PropagationWizard({
  resourceKeys,
  locationIds,
  environmentId,
  onClose,
}: PropagationWizardProps) {
  const { t } = useI18n();
  const l = t.library;
  const environmentsQuery = useEnvironmentEntitiesQuery();
  const environments = environmentsQuery.data ?? EMPTY_ENVIRONMENTS;
  const scopeEnvironmentId = environmentId ?? LOCAL_ENVIRONMENT_ID;

  /**
   * The machine the wizard was opened on, plus every other enabled one.
   *
   * Ordered with the current machine first so the step the user reads opens on
   * the box they were already looking at. Disabled machines are left out
   * entirely — they are configuration the user has switched off, not a machine
   * that happens to be unreachable, and the two need different answers.
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

  const request = useMemo<PropagationPreviewRequest>(
    () => ({
      resourceKeys: [...resourceKeys],
      // Empty until the environments query resolves: `environmentIds` below
      // only reflects the full machine set once it does, and previewing
      // before that would fire a second, more expensive preview the moment
      // it lands.
      targetLocationIds: environmentsQuery.isSuccess ? [...locationIds] : [],
      environmentIds,
    }),
    [resourceKeys, locationIds, environmentIds, environmentsQuery.isSuccess]
  );
  const wizard = usePropagation(request);
  const locationsQuery = useQuery(libraryLocationsQueryOptions(scopeEnvironmentId));
  const preview = wizard.preview;

  const unresolved = useMemo(
    () => (preview ? unresolvedEntries(preview, wizard.draft) : []),
    [preview, wizard.draft]
  );
  const pendingAcks = useMemo(
    () => (preview ? pendingAcknowledgements(preview, wizard.draft) : []),
    [preview, wizard.draft]
  );

  // A step that only says "nothing to choose" is not worth a stop. Until the
  // preview lands the answer is assumed to be no, since that is the common one
  // and the stepper then does not lose a segment when it arrives.
  const needsConflictStep =
    preview?.entries.some((entry) => entry.requiresWinnerSelection) ?? false;
  const stepOrder = needsConflictStep ? STEPS_WITH_CONFLICTS : STEPS_WITHOUT_CONFLICTS;
  // The controller opens on the conflict step; with none to settle that is
  // the destinations.
  const step = wizard.step === 'conflict' && !needsConflictStep ? 'destinations' : wizard.step;
  const stepIndex = stepOrder.indexOf(step);
  const title =
    resourceKeys.length === 1
      ? resourceTitle(l.wizard.titleOne, l.kindsInline, resourceKeys[0])
      : formatMessage(l.wizard.title, { count: String(resourceKeys.length) });

  // No candidate means no preview was ever requested, so every downstream step
  // would be reasoning about an absent answer.
  const hasDestinations = locationIds.length > 0;

  const canContinue =
    hasDestinations &&
    (step === 'conflict'
      ? unresolved.length === 0
      : step === 'destinations'
        ? wizard.draft.destinations.size > 0
        : false);

  const nothingToDo = preview ? isNoopApply(preview, wizard.draft) : true;
  const canApply = pendingAcks.length === 0 && !nothingToDo && !wizard.isApplying;

  return (
    <WizardFrame
      testId="propagation-wizard"
      title={title}
      steps={stepOrder.map((stepId) => stepLabel(l, stepId))}
      stepIndex={stepIndex}
      onClose={onClose}
      notes={
        <>
          {step === 'review' && pendingAcks.length > 0 && (
            <InlineNote tone="warning" data-testid="acknowledge-required">
              {l.adaptation.acknowledgeRequired}
            </InlineNote>
          )}
          {step === 'review' && pendingAcks.length === 0 && nothingToDo && (
            <InlineNote tone="warning" data-testid="nothing-to-do">
              {l.review.nothingToDo}
            </InlineNote>
          )}
          {wizard.applyError !== null && wizard.applyError !== undefined && (
            <InlineNote tone="danger">{l.review.applyError}</InlineNote>
          )}
        </>
      }
      actions={
        <>
          {/* Every step until the result offers Cancel, so the footer is always
              the way out; Back joins it once there is a step to go back to. */}
          {step !== 'result' && (
            <Button variant="secondary" onClick={onClose}>
              {l.wizard.cancel}
            </Button>
          )}
          {step !== 'result' && stepIndex > 0 && (
            <Button variant="secondary" onClick={() => wizard.setStep(stepOrder[stepIndex - 1])}>
              {l.wizard.back}
            </Button>
          )}
          {step === 'result' ? (
            <Button onClick={onClose}>{l.result.done}</Button>
          ) : step === 'review' ? (
            <Button
              onClick={wizard.apply}
              disabled={!canApply}
              loading={wizard.isApplying}
              data-testid="apply-button"
            >
              {wizard.isApplying ? l.review.applying : l.review.apply}
            </Button>
          ) : (
            <Button
              onClick={() => wizard.setStep(stepOrder[stepIndex + 1])}
              disabled={!canContinue}
              data-testid="continue-button"
            >
              {l.wizard.continue}
            </Button>
          )}
        </>
      }
    >
      {wizard.isStale && (
        <Callout
          tone="danger"
          title={l.wizard.stale}
          data-testid="stale-preview"
          action={
            <Button variant="secondary" size="sm" onClick={wizard.repreview}>
              {l.wizard.restale}
            </Button>
          }
        />
      )}

      {!hasDestinations ? (
        // Not a failure: nothing was asked, so there is nothing to retry.
        <LibraryPageState
          variant="empty"
          title={l.wizard.noDestinations}
          hint={l.wizard.noDestinationsHint}
        />
      ) : wizard.isPreviewing && !preview ? (
        <LibraryPageState variant="loading" />
      ) : wizard.previewError || !preview ? (
        <LibraryPageState
          variant="error"
          title={l.wizard.previewError}
          onRetry={wizard.repreview}
        />
      ) : step === 'conflict' ? (
        <ConflictStep
          preview={preview}
          draft={wizard.draft}
          unresolved={unresolved}
          onResolve={wizard.setResolution}
        />
      ) : step === 'destinations' ? (
        <DestinationStep
          preview={preview}
          draft={wizard.draft}
          locations={locationsQuery.data ?? []}
          environmentName={environmentName}
          onToggle={wizard.toggleDestination}
        />
      ) : step === 'review' ? (
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
          environmentName={environmentName}
          onUndo={wizard.undo}
        />
      )}
    </WizardFrame>
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
