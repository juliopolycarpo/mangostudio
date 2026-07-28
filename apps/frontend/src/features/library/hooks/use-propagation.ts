/**
 * The propagation wizard's runtime: preview, the evolving draft, apply, undo.
 *
 * A preview is always re-taken on open rather than restored from anywhere. The
 * wizard's *decisions* survive a refresh through the router, but the disk
 * reading behind them never does — 009 binds an apply to a `stateHash` and
 * rejects a stale one, so replaying an old preview would only fail later and
 * less clearly.
 */

import type {
  AdapterStrategy,
  LibraryLocationId,
  PropagationApply,
  PropagationPreview,
  PropagationPreviewRequest,
  PropagationResolution,
  PropagationUndo,
} from '@mangostudio/shared/library';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { applyPropagation, previewPropagation, undoPropagation } from '../api';
import {
  buildDecisions,
  initialDraft,
  operationKey,
  type WizardDraft,
  type WizardStep,
} from '../propagation';
import { libraryKeys } from '../queries';

/** Stand-in while the first preview is still in flight; never mutated. */
const EMPTY_DRAFT: WizardDraft = {
  resolutions: {},
  destinations: new Set(),
  strategies: {},
  acknowledged: new Set(),
};

export interface PropagationController {
  readonly step: WizardStep;
  readonly preview: PropagationPreview | undefined;
  readonly draft: WizardDraft;
  readonly isPreviewing: boolean;
  readonly previewError: unknown;
  readonly repreview: () => void;
  /** Set when the disk moved under the preview and an apply was refused. */
  readonly isStale: boolean;
  readonly setStep: (step: WizardStep) => void;
  readonly setResolution: (
    resourceKey: string,
    resolution: PropagationResolution,
    detail?: { winnerContentHash?: string; editedContent?: string }
  ) => void;
  readonly toggleDestination: (locationId: LibraryLocationId) => void;
  readonly setStrategy: (
    resourceKey: string,
    locationId: LibraryLocationId,
    strategy: AdapterStrategy
  ) => void;
  readonly toggleAcknowledgement: (resourceKey: string, locationId: LibraryLocationId) => void;
  readonly apply: () => void;
  readonly isApplying: boolean;
  readonly applyError: unknown;
  readonly result: PropagationApply | undefined;
  readonly undo: () => void;
  readonly isUndoing: boolean;
  readonly undoError: unknown;
  readonly undoResult: PropagationUndo | undefined;
}

export function usePropagation(request: PropagationPreviewRequest): PropagationController {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<WizardStep>('conflict');
  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [result, setResult] = useState<PropagationApply | undefined>(undefined);

  const requestKey = useMemo(
    () => [...request.resourceKeys].sort().join(','),
    [request.resourceKeys]
  );
  const locationKey = useMemo(
    () => [...request.targetLocationIds].sort().join(','),
    [request.targetLocationIds]
  );

  const previewQuery = useQuery({
    queryKey: [...libraryKeys.all, 'preview', requestKey, locationKey],
    // A preview is a snapshot of the disk, never something to serve from cache.
    gcTime: 0,
    staleTime: 0,
    retry: false,
    queryFn: () => previewPropagation(request),
  });

  const preview = previewQuery.data;

  // Seeding runs whenever a new preview lands, including after a re-preview:
  // the old draft may name a winner hash that no longer exists on disk.
  useEffect(() => {
    if (!preview) return;
    setDraft((current) => (current === null ? initialDraft(preview) : current));
  }, [preview]);

  const effectiveDraft = useMemo<WizardDraft>(() => draft ?? EMPTY_DRAFT, [draft]);

  const repreview = useCallback(() => {
    setIsStale(false);
    setDraft(null);
    void previewQuery.refetch();
  }, [previewQuery]);

  const applyMutation = useMutation({
    mutationFn: () =>
      preview
        ? applyPropagation({
            previewToken: preview.previewToken,
            stateHash: preview.stateHash,
            request,
            decisions: buildDecisions(preview, effectiveDraft),
          })
        : Promise.reject(new Error('No preview to apply.')),
    onSuccess: (outcome) => {
      if (outcome.outcome === 'stale') {
        setIsStale(true);
        return;
      }
      setResult(outcome.result);
      setStep('result');
      void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
    },
  });

  const undoMutation = useMutation({
    mutationFn: (backupId: string) => undoPropagation(backupId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKeys.all }),
  });

  const setResolution = useCallback(
    (
      resourceKey: string,
      resolution: PropagationResolution,
      detail?: { winnerContentHash?: string; editedContent?: string }
    ) => {
      setDraft((current) => {
        if (!current) return current;
        return {
          ...current,
          resolutions: {
            ...current.resolutions,
            [resourceKey]: {
              resolution,
              ...(detail?.winnerContentHash !== undefined && {
                winnerContentHash: detail.winnerContentHash,
              }),
              ...(detail?.editedContent !== undefined && { editedContent: detail.editedContent }),
            },
          },
        };
      });
    },
    []
  );

  const toggleDestination = useCallback((locationId: LibraryLocationId) => {
    setDraft((current) => {
      if (!current) return current;
      const destinations = new Set(current.destinations);
      if (!destinations.delete(locationId)) destinations.add(locationId);
      return { ...current, destinations };
    });
  }, []);

  const setStrategy = useCallback(
    (resourceKey: string, locationId: LibraryLocationId, strategy: AdapterStrategy) => {
      setDraft((current) => {
        if (!current) return current;
        const key = operationKey(resourceKey, locationId);
        // Changing the strategy invalidates any sign-off: the draft the user
        // approved is not the draft the new strategy would produce.
        const acknowledged = new Set(current.acknowledged);
        acknowledged.delete(key);
        return { ...current, strategies: { ...current.strategies, [key]: strategy }, acknowledged };
      });
    },
    []
  );

  const toggleAcknowledgement = useCallback(
    (resourceKey: string, locationId: LibraryLocationId) => {
      setDraft((current) => {
        if (!current) return current;
        const acknowledged = new Set(current.acknowledged);
        const key = operationKey(resourceKey, locationId);
        if (!acknowledged.delete(key)) acknowledged.add(key);
        return { ...current, acknowledged };
      });
    },
    []
  );

  return {
    step,
    preview,
    draft: effectiveDraft,
    isPreviewing: previewQuery.isFetching,
    previewError: previewQuery.error,
    repreview,
    isStale,
    setStep,
    setResolution,
    toggleDestination,
    setStrategy,
    toggleAcknowledgement,
    apply: useCallback(() => applyMutation.mutate(), [applyMutation]),
    isApplying: applyMutation.isPending,
    applyError: applyMutation.error,
    result,
    undo: useCallback(() => {
      if (result?.backupId) undoMutation.mutate(result.backupId);
    }, [result?.backupId, undoMutation]),
    isUndoing: undoMutation.isPending,
    undoError: undoMutation.error,
    undoResult: undoMutation.data,
  };
}
