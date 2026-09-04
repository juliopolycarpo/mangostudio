/**
 * One install button and everything that follows it: the confirmation dialog,
 * the live console, and the copyable command when the guards refuse.
 *
 * The same button serves all three outcomes, so a blocked install never leaves
 * the user staring at a control that simply does nothing.
 *
 * When the recipe needs something the machine does not have, the button offers
 * the chain that gets there — "Install nvm, then Node" — rather than an install
 * that would be refused for a requirement the catalog could have satisfied. A
 * requirement nothing here installs is stated instead of offered: an affordance
 * that cannot succeed is worse than a sentence saying so.
 */

import type { InstallRecipePreview, RecipeInput } from '@mangostudio/shared/environments';
import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { chainStepLabel, runtimeNameList } from '../format';
import { chainStopped, useInstallFlow } from '../hooks/use-install-flow';
import { useInstallStream } from '../hooks/use-install-stream';
import { useToolIdentities } from '../identity/use-tool-identities';
import type { InstallChainStep } from '../install-chain';
import { resolveInstallChain } from '../install-chain';
import { CopyCommandBlock } from './CopyCommandBlock';
import { InstallConfirmDialog } from './InstallConfirmDialog';
import { InstallConsole } from './InstallConsole';

interface InstallActionProps {
  recipe: InstallRecipePreview | undefined;
  input: RecipeInput;
  label: string;
  /**
   * Every recipe the server offers for this machine. Required, because a
   * recipe's missing requirements can only be turned into a chain — or
   * reported as unreachable — by looking at what else is on offer.
   */
  catalog: readonly InstallRecipePreview[];
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  icon?: ReactNode;
  /** Which machine to install on; omitted means the hub's own. */
  environmentId?: string;
  /**
   * Steps appended after `recipe`'s own resolved chain, run in the same
   * confirmation and console — a "make it the default" step that only means
   * anything once the install before it has landed. Kept out of the button's
   * own chain-prerequisite wording: these finish what `label` already
   * promised rather than naming a second visible milestone.
   */
  followUpSteps?: readonly InstallChainStep[];
}

export function InstallAction({
  recipe,
  input,
  label,
  catalog,
  variant = 'secondary',
  size = 'sm',
  icon,
  environmentId,
  followUpSteps,
}: InstallActionProps) {
  const { t } = useI18n();
  const s = t.environments.install;
  const { resolve } = useToolIdentities();
  const flow = useInstallFlow(environmentId);
  const { dismiss } = flow;
  const refusedByGuard = flow.state.step === 'refused' && !flow.state.recipe.guard.allowed;
  const guardAllowedNow = recipe?.guard.allowed === true;
  // A refusal that was the guard's alone ends when the guard flips — the
  // one-click enable re-fetches the catalog, and the card must offer the
  // install again instead of keeping the stale copy block on screen.
  useEffect(() => {
    if (refusedByGuard && guardAllowedNow) dismiss();
  }, [refusedByGuard, guardAllowedNow, dismiss]);
  // The console must survive the run that produced it: `finished` keeps the same
  // runId as `running`, so the stream hook is not torn down (and its buffer
  // reset to idle) the instant the exit event moves the flow forward.
  const progress = 'chain' in flow.state ? flow.state.chain : null;
  const stream = useInstallStream({
    runId: progress?.runId ?? null,
    onExit: (event) => void flow.complete(event),
  });

  // Every call site writes `input` as a literal, so depending on the object
  // itself would re-walk the catalog on every render of every card — and these
  // cards re-render on a 15s status poll. The chain depends on the input's
  // value, so the value is what the memo keys on.
  const inputKey = input.kind === 'node-version' ? `node-version:${input.version}` : input.kind;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `inputKey` is `input` by value.
  const chain = useMemo(
    () => (recipe ? resolveInstallChain(catalog, recipe, input) : null),
    [catalog, inputKey, recipe]
  );

  // A recipe the server never listed cannot be run or explained, so the whole
  // affordance stays out of the way instead of rendering a dead button.
  if (!recipe || !chain) return null;

  const runtimeName = (id: InstallRecipePreview['runtimeId']) => resolve('runtime', id).name;

  // No vendor-documented unattended shape exists: the copyable command is the
  // whole offer, and a "Run" button that could never fire would only invite a
  // click that goes nowhere.
  if (!recipe.runnable) {
    return (
      <div className="space-y-2" data-testid="install-unrunnable">
        <p className="text-sm text-on-surface-variant/70">
          {s.unrunnable[recipe.unrunnableReason ?? 'vendor-undocumented']}
        </p>
        <CopyCommandBlock recipe={recipe} environmentId={environmentId} />
      </div>
    );
  }

  if (chain.kind === 'unresolved') {
    return (
      <p className="text-sm text-on-surface-variant/70" data-testid="install-unresolved">
        {formatMessage(s.requirementUnavailable, {
          target: runtimeName(recipe.runtimeId),
          requirements: runtimeNameList(resolve, chain.missing),
        })}
      </p>
    );
  }

  // Prerequisites (for the button's "Install X, then Y" wording) come only
  // from `recipe`'s own missing-requirement chain — a follow-up step is not a
  // second milestone the button announces, just how the promised one finishes.
  const prerequisites = chain.steps.slice(0, -1);
  const steps: readonly InstallChainStep[] =
    followUpSteps && followUpSteps.length > 0 ? [...chain.steps, ...followUpSteps] : chain.steps;
  const isBusy = flow.state.step === 'preparing' || flow.state.step === 'starting';
  const showConsole = progress?.runId != null;
  const currentStep = progress ? progress.steps[progress.index] : undefined;
  const stepLabel =
    progress && progress.steps.length > 1 && currentStep
      ? chainStepLabel(
          t,
          progress.index,
          progress.steps.length,
          runtimeName(currentStep.recipe.runtimeId)
        )
      : undefined;

  return (
    <div className="space-y-3">
      {flow.state.step !== 'refused' && !showConsole && (
        <Button
          variant={variant}
          size={size}
          loading={isBusy}
          onClick={() => void flow.begin(steps)}
        >
          {icon}
          {prerequisites.length === 0
            ? label
            : formatMessage(s.chainLabel, {
                prerequisites: runtimeNameList(
                  resolve,
                  prerequisites.map((step) => step.recipe.runtimeId)
                ),
                target: runtimeName(recipe.runtimeId),
              })}
        </Button>
      )}

      {flow.state.step === 'error' && (
        <p className="text-sm text-error">{t.environments.install.startError}</p>
      )}

      {flow.state.step === 'refused' && (
        <CopyCommandBlock
          recipe={flow.state.recipe}
          message={flow.state.message}
          environmentId={environmentId}
        />
      )}

      {(flow.state.step === 'confirming' ||
        (flow.state.step === 'starting' && flow.state.chain.index === 0)) && (
        <InstallConfirmDialog
          preparation={flow.state.preparation}
          steps={flow.state.chain.steps}
          isStarting={flow.state.step === 'starting'}
          onConfirm={() => void flow.confirm()}
          onCancel={flow.dismiss}
        />
      )}

      {showConsole && (
        <InstallConsole
          stream={stream}
          {...(stepLabel && { stepLabel })}
          onCancel={() => void flow.cancel()}
          onClose={flow.dismiss}
        />
      )}

      {flow.state.step === 'finished' && chainStopped(flow.state.chain) && currentStep && (
        <p className="text-sm text-error" data-testid="install-chain-stopped">
          {formatMessage(s.chainStopped, {
            target: runtimeName(recipe.runtimeId),
            prerequisite: runtimeName(currentStep.recipe.runtimeId),
          })}
        </p>
      )}
    </div>
  );
}
