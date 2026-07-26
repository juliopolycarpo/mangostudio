/**
 * Drives one install from button press to re-probe.
 *
 * The guard is evaluated from the recipe preview *before* any request goes out:
 * when installs are refused the feature degrades to a copyable command instead
 * of firing a request the server would only reject.
 */

import type {
  InstallPreparation,
  InstallRecipePreview,
  RecipeInput,
} from '@mangostudio/shared/environments';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { cancelInstall, prepareInstall, startInstall } from '../api';
import { environmentKeys } from '../queries';

export type InstallFlowState =
  | { readonly step: 'idle' }
  | { readonly step: 'preparing'; readonly recipe: InstallRecipePreview }
  | {
      readonly step: 'confirming';
      readonly recipe: InstallRecipePreview;
      readonly preparation: InstallPreparation;
    }
  | {
      readonly step: 'starting';
      readonly recipe: InstallRecipePreview;
      readonly preparation: InstallPreparation;
    }
  | { readonly step: 'running'; readonly recipe: InstallRecipePreview; readonly runId: string }
  | { readonly step: 'finished'; readonly recipe: InstallRecipePreview; readonly runId: string }
  /** No request was issued (or the server refused): show the copyable command. */
  | {
      readonly step: 'refused';
      readonly recipe: InstallRecipePreview;
      readonly message: string;
    }
  | { readonly step: 'error'; readonly recipe: InstallRecipePreview };

/** True when the recipe cannot run here, so no request should be attempted. */
function isInstallRefused(recipe: InstallRecipePreview): boolean {
  return !recipe.guard.allowed || !recipe.supported || recipe.missingRequirements.length > 0;
}

export function useInstallFlow() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<InstallFlowState>({ step: 'idle' });
  const requestIdRef = useRef(0);

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: environmentKeys.all });
  }, [queryClient]);

  const dismiss = useCallback(() => {
    requestIdRef.current += 1;
    setState({ step: 'idle' });
  }, []);

  /**
   * Prepares the recipe so the confirmation dialog can show the exact argv the
   * server will run, including a downloaded installer's origin and size.
   */
  const begin = useCallback(async (recipe: InstallRecipePreview, input: RecipeInput) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (isInstallRefused(recipe)) {
      setState({ step: 'refused', recipe, message: '' });
      return;
    }

    setState({ step: 'preparing', recipe });
    try {
      const result = await prepareInstall({ recipeId: recipe.id, input });
      if (requestIdRef.current !== requestId) return;
      if (result.outcome === 'refused') {
        setState({ step: 'refused', recipe: result.recipe, message: result.message });
        return;
      }
      setState({
        step: 'confirming',
        recipe: result.preparation.recipe,
        preparation: result.preparation,
      });
    } catch {
      if (requestIdRef.current !== requestId) return;
      setState({ step: 'error', recipe });
    }
  }, []);

  const confirm = useCallback(
    async (input: RecipeInput) => {
      const current = state;
      if (current.step !== 'confirming') return;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      setState({ step: 'starting', recipe: current.recipe, preparation: current.preparation });
      try {
        const result = await startInstall({
          recipeId: current.recipe.id,
          input,
          ...(current.preparation.preparationId && {
            preparationId: current.preparation.preparationId,
          }),
        });
        if (requestIdRef.current !== requestId) return;
        if (result.outcome === 'refused') {
          setState({ step: 'refused', recipe: result.recipe, message: result.message });
          return;
        }
        setState({ step: 'running', recipe: current.recipe, runId: result.run.runId });
      } catch {
        if (requestIdRef.current !== requestId) return;
        setState({ step: 'error', recipe: current.recipe });
      }
    },
    [state]
  );

  const cancel = useCallback(async () => {
    if (state.step !== 'running') return;
    try {
      await cancelInstall(state.runId);
    } catch {
      // The run may have finished between render and click; the exit event is
      // the authority on the outcome either way.
    }
  }, [state]);

  /** Called when the stream reports its exit: the probe results land here. */
  const complete = useCallback(async () => {
    setState((previous) =>
      previous.step === 'running'
        ? { step: 'finished', recipe: previous.recipe, runId: previous.runId }
        : previous
    );
    await invalidate();
  }, [invalidate]);

  return { state, begin, confirm, cancel, complete, dismiss };
}
