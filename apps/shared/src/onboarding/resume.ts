import { isOnboardingComplete } from './defaults';
import { ONBOARDING_STEP_IDS, type OnboardingState, type OnboardingStepId } from './schemas';

/**
 * What the machine currently says about one step.
 *
 * `unknown` is the load-bearing member: a query that is still in flight or has
 * failed must never read as `unsatisfied`, or a resume would drag someone back
 * to a step they finished last week because a request was slow.
 * `unavailable` means the step cannot be acted on from here at all — the hub
 * service, for instance, when the browser is not on the hub's own machine.
 */
export type OnboardingFact = 'satisfied' | 'unsatisfied' | 'unknown' | 'unavailable';

/** Live facts for every step whose answer the machine owns. `welcome` has none — see below. */
export interface OnboardingMachineFacts {
  readonly folder: OnboardingFact;
  readonly toolchain: OnboardingFact;
  readonly agents: OnboardingFact;
  readonly service: OnboardingFact;
  readonly chat: OnboardingFact;
}

export type OnboardingStepStatus = 'satisfied' | 'skipped' | 'pending' | 'unknown' | 'unavailable';

/**
 * Where the flow should open. `undecided` is not a failure: it means a fact an
 * earlier step depends on has not arrived, and answering now could send the
 * person backwards. Callers wait rather than guess.
 */
export type OnboardingResume =
  | { readonly kind: 'step'; readonly step: OnboardingStepId }
  | { readonly kind: 'undecided' }
  | { readonly kind: 'done' };

function factFor(
  step: OnboardingStepId,
  state: OnboardingState,
  facts: OnboardingMachineFacts
): OnboardingFact {
  // No machine fact can say whether someone has read a welcome screen, so this
  // one step carries its own bit in the persisted record.
  if (step === 'welcome') return state.welcomeAcknowledged ? 'satisfied' : 'unsatisfied';
  return facts[step];
}

/**
 * Per-step status, combining what the person chose with what the machine says.
 *
 * A step the machine now satisfies reads as satisfied even if it was skipped
 * earlier — installing a toolchain after skipping that step should show as
 * done, not as a permanent skip.
 *
 * @example
 * onboardingStepStatuses(state, facts).toolchain; // => 'pending'
 */
export function onboardingStepStatuses(
  state: OnboardingState,
  facts: OnboardingMachineFacts
): Record<OnboardingStepId, OnboardingStepStatus> {
  const skipped = new Set(state.skippedSteps);
  const entries = ONBOARDING_STEP_IDS.map((step) => {
    const fact = factFor(step, state, facts);
    if (fact === 'satisfied') return [step, 'satisfied'] as const;
    if (skipped.has(step)) return [step, 'skipped'] as const;
    if (fact === 'unavailable') return [step, 'unavailable'] as const;
    if (fact === 'unknown') return [step, 'unknown'] as const;
    return [step, 'pending'] as const;
  });
  return Object.fromEntries(entries) as Record<OnboardingStepId, OnboardingStepStatus>;
}

/**
 * The first step still waiting on the person, read from current facts rather
 * than from a remembered cursor — so a machine that changed underneath them
 * (folder deleted, agent signed out) reopens at the step that changed.
 *
 * @example
 * const resume = resumeOnboarding(state, facts);
 * if (resume.kind === 'step') setStep(resume.step);
 */
export function resumeOnboarding(
  state: OnboardingState,
  facts: OnboardingMachineFacts
): OnboardingResume {
  if (isOnboardingComplete(state)) return { kind: 'done' };

  const statuses = onboardingStepStatuses(state, facts);
  for (const step of ONBOARDING_STEP_IDS) {
    // Stop at the first fact we do not have: a later pending step is not
    // provably the earliest one while an earlier answer is still missing.
    if (statuses[step] === 'unknown') return { kind: 'undecided' };
    if (statuses[step] === 'pending') return { kind: 'step', step };
  }
  return { kind: 'done' };
}
