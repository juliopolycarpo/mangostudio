/**
 * The removal wizard's runtime: preview, the evolving draft, apply, undo.
 *
 * A preview is always re-taken on open, never restored. The apply is bound to a
 * `stateHash` and rejected when it goes stale, and staleness matters more here
 * than in propagation: between the preview and the button the user may have
 * edited the very copy they are about to delete.
 */

import type {
  LibraryLocationId,
  PropagationUndo,
  RemovalApply,
  RemovalPreview,
  RemovalPreviewRequest,
} from '@mangostudio/shared/library';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { applyRemoval, previewRemoval, undoPropagation } from '../api';
import { libraryKeys } from '../queries';
import {
  acknowledgedLastCopyKeys,
  buildRemovalDecisions,
  initialRemovalDraft,
  type RemovalDraft,
  type RemovalStep,
  removalKey,
} from '../removal';

const EMPTY_DRAFT: RemovalDraft = initialRemovalDraft();

export interface RemovalController {
  readonly step: RemovalStep;
  readonly preview: RemovalPreview | undefined;
  readonly draft: RemovalDraft;
  readonly isPreviewing: boolean;
  readonly previewError: unknown;
  readonly repreview: () => void;
  /** Set when the disk moved under the preview and an apply was refused. */
  readonly isStale: boolean;
  /** Set when the API found a last copy the wizard did not; re-preview is the way out. */
  readonly needsLastCopyReview: boolean;
  readonly setStep: (step: RemovalStep) => void;
  readonly toggleLocation: (
    resourceKey: string,
    environmentId: string,
    locationId: LibraryLocationId
  ) => void;
  readonly toggleAcknowledgement: (resourceKey: string) => void;
  readonly apply: () => void;
  readonly isApplying: boolean;
  readonly applyError: unknown;
  readonly result: RemovalApply | undefined;
  /** One backup set on one machine; a cross-machine removal produced several. */
  readonly undo: (environmentId: string, backupId: string) => void;
  /** Keyed per handle: a cross-machine removal has one mutation in flight per machine. */
  readonly isUndoing: (environmentId: string, backupId: string) => boolean;
  readonly undoError: (environmentId: string, backupId: string) => unknown;
  readonly undoResult: (environmentId: string, backupId: string) => PropagationUndo | undefined;
}

function backupHandleKey(environmentId: string, backupId: string): string {
  return `${environmentId}:${backupId}`;
}

export function useRemoval(request: RemovalPreviewRequest): RemovalController {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<RemovalStep>('locations');
  const [draft, setDraft] = useState<RemovalDraft | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [needsLastCopyReview, setNeedsLastCopyReview] = useState(false);
  const [result, setResult] = useState<RemovalApply | undefined>(undefined);

  const requestKey = useMemo(
    () => [...request.resourceKeys].sort().join(','),
    [request.resourceKeys]
  );
  const locationKey = useMemo(
    () => [...request.locationIds].sort().join(','),
    [request.locationIds]
  );
  const environmentKey = useMemo(
    () => [...(request.environmentIds ?? [])].sort().join(','),
    [request.environmentIds]
  );

  const canPreview = request.resourceKeys.length > 0 && request.locationIds.length > 0;

  const previewQuery = useQuery({
    queryKey: [...libraryKeys.all, 'removal-preview', requestKey, locationKey, environmentKey],
    // A preview is a snapshot of the disk, never something to serve from cache.
    gcTime: 0,
    staleTime: 0,
    retry: false,
    enabled: canPreview,
    queryFn: () => previewRemoval(request),
  });

  const preview = previewQuery.data;

  // A new preview always starts from an empty selection. Carrying checkboxes
  // across a re-read would let a user confirm a deletion they chose against a
  // picture of the disk that no longer holds. Keyed on the preview token rather
  // than on the draft being unset, because a refetch — an invalidation
  // elsewhere, a changed location set — replaces the preview without ever
  // passing through null, and that is exactly the case worth resetting.
  // Both rejection banners go with it. Each one says "preview again before
  // removing", and a preview that just arrived is the thing they were asking
  // for — leaving them up would tell the user to redo work already done.
  const previewToken = preview?.previewToken;
  useEffect(() => {
    if (previewToken === undefined) return;
    setDraft(initialRemovalDraft());
    setIsStale(false);
    setNeedsLastCopyReview(false);
  }, [previewToken]);

  const effectiveDraft = useMemo<RemovalDraft>(() => draft ?? EMPTY_DRAFT, [draft]);

  const repreview = useCallback(() => {
    if (!canPreview) return;
    setIsStale(false);
    setNeedsLastCopyReview(false);
    setDraft(null);
    setStep('locations');
    void previewQuery.refetch();
  }, [canPreview, previewQuery]);

  const applyMutation = useMutation({
    mutationFn: () =>
      preview
        ? applyRemoval({
            previewToken: preview.previewToken,
            stateHash: preview.stateHash,
            request,
            decisions: buildRemovalDecisions(preview, effectiveDraft),
            acknowledgeLastCopy: acknowledgedLastCopyKeys(preview, effectiveDraft),
          })
        : Promise.reject(new Error('No preview to apply.')),
    onSuccess: (outcome) => {
      if (outcome.outcome === 'stale') {
        setIsStale(true);
        return;
      }
      if (outcome.outcome === 'last-copy-unacknowledged') {
        setNeedsLastCopyReview(true);
        return;
      }
      setResult(outcome.result);
      setStep('result');
      void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
    },
  });

  // A cross-machine removal produces one backup handle per machine, so the
  // mutation's own single result/error/pending would apply to every handle at
  // once — restoring machine B would clear machine A's confirmation, and a
  // failure on one machine would render on all of them. Track outcomes and
  // in-flight state per handle instead.
  const [undoingKey, setUndoingKey] = useState<string | undefined>(undefined);
  const [undoResults, setUndoResults] = useState<ReadonlyMap<string, PropagationUndo>>(new Map());
  const [undoErrors, setUndoErrors] = useState<ReadonlyMap<string, unknown>>(new Map());

  const undoMutation = useMutation({
    mutationFn: (target: { environmentId: string; backupId: string }) =>
      undoPropagation(target.backupId, target.environmentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: libraryKeys.all }),
  });

  const toggleLocation = useCallback(
    (resourceKey: string, environmentId: string, locationId: LibraryLocationId) => {
      setDraft((current) => {
        if (!current) return current;
        const removing = new Set(current.removing);
        const key = removalKey(resourceKey, environmentId, locationId);
        if (!removing.delete(key)) removing.add(key);
        // Unchecking a copy can turn a last-copy removal back into an ordinary
        // one, so a sign-off given for the old selection must not survive it.
        const acknowledged = new Set(current.acknowledged);
        acknowledged.delete(resourceKey);
        return { removing, acknowledged };
      });
    },
    []
  );

  const toggleAcknowledgement = useCallback((resourceKey: string) => {
    setDraft((current) => {
      if (!current) return current;
      const acknowledged = new Set(current.acknowledged);
      if (!acknowledged.delete(resourceKey)) acknowledged.add(resourceKey);
      return { ...current, acknowledged };
    });
  }, []);

  return {
    step,
    preview,
    draft: effectiveDraft,
    isPreviewing: previewQuery.isFetching,
    previewError: previewQuery.error,
    repreview,
    isStale,
    needsLastCopyReview,
    setStep,
    toggleLocation,
    toggleAcknowledgement,
    apply: useCallback(() => applyMutation.mutate(), [applyMutation]),
    isApplying: applyMutation.isPending,
    applyError: applyMutation.error,
    result,
    undo: useCallback(
      (environmentId: string, backupId: string) => {
        const key = backupHandleKey(environmentId, backupId);
        setUndoingKey(key);
        setUndoErrors((current) => {
          if (!current.has(key)) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        });
        undoMutation.mutate(
          { environmentId, backupId },
          {
            onSuccess: (data) => setUndoResults((current) => new Map(current).set(key, data)),
            onError: (error) => setUndoErrors((current) => new Map(current).set(key, error)),
            onSettled: () => setUndoingKey((current) => (current === key ? undefined : current)),
          }
        );
      },
      [undoMutation]
    ),
    isUndoing: useCallback(
      (environmentId: string, backupId: string) =>
        undoingKey === backupHandleKey(environmentId, backupId),
      [undoingKey]
    ),
    undoError: useCallback(
      (environmentId: string, backupId: string) =>
        undoErrors.get(backupHandleKey(environmentId, backupId)),
      [undoErrors]
    ),
    undoResult: useCallback(
      (environmentId: string, backupId: string) =>
        undoResults.get(backupHandleKey(environmentId, backupId)),
      [undoResults]
    ),
  };
}
