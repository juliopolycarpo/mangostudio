/**
 * Drives one install from button press to re-probe — or a whole prerequisite
 * chain, which is the same thing with more than one step.
 *
 * The guard is evaluated from the recipe preview *before* any request goes out:
 * when installs are refused the feature degrades to a copyable command instead
 * of firing a request the server would only reject.
 *
 * A chain confirms once and then runs unattended. Each step is still prepared
 * against the server immediately before it runs, because a step's argv and its
 * requirements are only knowable once the step before it has landed — nvm's
 * directory does not exist while nvm is still being installed.
 */

import type {
  InstallExitEvent,
  InstallPreparation,
  InstallRecipePreview,
} from '@mangostudio/shared/environments';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { cancelInstall, prepareInstall, startInstall } from '../api';
import type { InstallChainStep } from '../install-chain';
import { environmentKeys } from '../queries';

export interface InstallChainProgress {
  /** Prerequisites first; the recipe the user asked for is last. */
  readonly steps: readonly InstallChainStep[];
  readonly index: number;
  /**
   * The run whose console is on screen. It outlives its own step so the output
   * of the step that just finished stays visible while the next one is being
   * prepared, rather than blinking out between runs.
   */
  readonly runId: string | null;
}

export type InstallFlowState =
  | { readonly step: 'idle' }
  | { readonly step: 'preparing'; readonly chain: InstallChainProgress }
  | {
      readonly step: 'confirming';
      readonly chain: InstallChainProgress;
      readonly preparation: InstallPreparation;
    }
  | {
      readonly step: 'starting';
      readonly chain: InstallChainProgress;
      readonly preparation: InstallPreparation;
    }
  | { readonly step: 'running'; readonly chain: InstallChainProgress }
  | {
      readonly step: 'finished';
      readonly chain: InstallChainProgress;
      /** A step ended without succeeding, so the steps after it never ran. */
      readonly stopped: boolean;
    }
  /** No request was issued (or the server refused): show the copyable command. */
  | {
      readonly step: 'refused';
      readonly recipe: InstallRecipePreview;
      readonly message: string;
    }
  | { readonly step: 'error'; readonly recipe: InstallRecipePreview };

function targetOf(steps: readonly InstallChainStep[]): InstallRecipePreview {
  const last = steps.at(-1);
  if (!last) throw new Error('An install chain needs at least one step.');
  return last.recipe;
}

/**
 * The recipe to report when nothing should be attempted, or `null` when the
 * chain is runnable.
 *
 * Guards and platform support are properties of the machine, so they refuse the
 * whole chain. Missing requirements are only a refusal on the *first* step:
 * every later step's requirements are what the steps before it install.
 */
function chainRefusal(steps: readonly InstallChainStep[]): InstallRecipePreview | null {
  const target = targetOf(steps);
  if (!target.guard.allowed) return target;
  const unsupported = steps.find((step) => !step.recipe.supported);
  if (unsupported) return unsupported.recipe;
  const first = steps[0];
  if (first && first.recipe.missingRequirements.length > 0) return first.recipe;
  return null;
}

export function useInstallFlow(environmentId?: string) {
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
   * Prepares one step so the confirmation can show the exact argv the server
   * will run, including a downloaded installer's origin and size. Returns the
   * preparation, or `null` when the request was refused or superseded — both
   * of which have already written the state they need.
   */
  const prepareStep = useCallback(
    async (chain: InstallChainProgress, requestId: number): Promise<InstallPreparation | null> => {
      const step = chain.steps[chain.index];
      if (!step) return null;
      const result = await prepareInstall({
        recipeId: step.recipe.id,
        input: step.input,
        ...(environmentId && { environmentId }),
      });
      if (requestIdRef.current !== requestId) return null;
      if (result.outcome === 'refused') {
        setState({ step: 'refused', recipe: result.recipe, message: result.message });
        return null;
      }
      return result.preparation;
    },
    [environmentId]
  );

  const startStep = useCallback(
    async (
      chain: InstallChainProgress,
      preparation: InstallPreparation,
      requestId: number
    ): Promise<void> => {
      const step = chain.steps[chain.index];
      if (!step) return;
      const result = await startInstall({
        recipeId: step.recipe.id,
        input: step.input,
        ...(environmentId && { environmentId }),
        ...(preparation.preparationId && { preparationId: preparation.preparationId }),
      });
      if (requestIdRef.current !== requestId) return;
      if (result.outcome === 'refused') {
        setState({ step: 'refused', recipe: result.recipe, message: result.message });
        return;
      }
      setState({ step: 'running', chain: { ...chain, runId: result.run.runId } });
    },
    [environmentId]
  );

  /**
   * Runs the next step of a chain the user already confirmed. Nothing is asked
   * again: one affordance was pressed, so one decision was made.
   */
  const advance = useCallback(
    async (chain: InstallChainProgress): Promise<void> => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      const next: InstallChainProgress = { ...chain, index: chain.index + 1 };

      setState({ step: 'preparing', chain: next });
      try {
        const preparation = await prepareStep(next, requestId);
        if (!preparation || requestIdRef.current !== requestId) return;
        setState({ step: 'starting', chain: next, preparation });
        await startStep(next, preparation, requestId);
      } catch {
        if (requestIdRef.current !== requestId) return;
        setState({ step: 'error', recipe: targetOf(next.steps) });
      }
    },
    [prepareStep, startStep]
  );

  const begin = useCallback(
    async (steps: readonly InstallChainStep[]) => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      const refused = chainRefusal(steps);
      if (refused) {
        setState({ step: 'refused', recipe: refused, message: '' });
        return;
      }

      const chain: InstallChainProgress = { steps, index: 0, runId: null };
      setState({ step: 'preparing', chain });
      try {
        const preparation = await prepareStep(chain, requestId);
        if (!preparation || requestIdRef.current !== requestId) return;
        setState({ step: 'confirming', chain, preparation });
      } catch {
        if (requestIdRef.current !== requestId) return;
        setState({ step: 'error', recipe: targetOf(steps) });
      }
    },
    [prepareStep]
  );

  const confirm = useCallback(async () => {
    const current = state;
    if (current.step !== 'confirming') return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setState({ step: 'starting', chain: current.chain, preparation: current.preparation });
    try {
      await startStep(current.chain, current.preparation, requestId);
    } catch {
      if (requestIdRef.current !== requestId) return;
      setState({ step: 'error', recipe: targetOf(current.chain.steps) });
    }
  }, [startStep, state]);

  const cancel = useCallback(async () => {
    if (state.step !== 'running' || !state.chain.runId) return;
    try {
      await cancelInstall(state.chain.runId);
    } catch {
      // The run may have finished between render and click; the exit event is
      // the authority on the outcome either way.
    }
  }, [state]);

  /**
   * Called when the stream reports its exit: the probe results land here, and
   * so does the decision to run the next step.
   *
   * Only a success continues the chain. Installing Node on top of an nvm that
   * failed would fail too — with a worse message than the one already on
   * screen — so a step that did not succeed ends the run.
   */
  const complete = useCallback(
    async (exit: InstallExitEvent) => {
      const current = state;
      await invalidate();
      if (current.step !== 'running') return;
      const { chain } = current;
      const remaining = chain.index + 1 < chain.steps.length;
      if (exit.status === 'succeeded' && remaining) {
        await advance(chain);
        return;
      }
      setState((previous) =>
        previous.step === 'running'
          ? { step: 'finished', chain: previous.chain, stopped: remaining }
          : previous
      );
    },
    [advance, invalidate, state]
  );

  return { state, begin, confirm, cancel, complete, dismiss };
}
