/**
 * First-run setup, end to end.
 *
 * Every action here is one the rest of the application already offers — a
 * folder picker, the environment manager, the runner selector, the service
 * card, a chat. What this adds is an order, a reason for each step, and the
 * memory to leave and come back. Nothing is only reachable from here, which is
 * why skipping costs nothing: any step that is still asking something can be
 * skipped, and the whole run can be skipped from the header.
 *
 * Where the flow opens is derived, never remembered: `resumeOnboarding` reads
 * what the machine says now against what the person has answered, so a folder
 * deleted or an agent signed out after the fact reopens at that step.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type { OnboardingStepId } from '@mangostudio/shared/onboarding';
import {
  ONBOARDING_STEP_IDS,
  onboardingStepStatuses,
  resumeOnboarding,
} from '@mangostudio/shared/onboarding';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { Logo } from '@/components/ui/Logo';
import { Spinner } from '@/components/ui/Spinner';
import { SELECTION_BAR } from '@/components/ui/selection-bar';
import { ExternalDisclosureGate } from '@/features/external-agents/ExternalDisclosureGate';
import { ExternalWorkspaceTrustGate } from '@/features/external-agents/ExternalWorkspaceTrustGate';
import { useI18n } from '@/hooks/use-i18n';
import { useSignOut } from '@/hooks/use-sign-out';
import { formatMessage } from '@/lib/i18n-format';
import { cn } from '@/lib/utils';
import { StepStatusChip } from './StepStatusChip';
import { AgentsStep } from './steps/AgentsStep';
import { FirstChatStep } from './steps/FirstChatStep';
import { FolderStep } from './steps/FolderStep';
import { ServiceStep } from './steps/ServiceStep';
import { ToolchainStep } from './steps/ToolchainStep';
import { WelcomeStep } from './steps/WelcomeStep';
import { useOnboardingFacts } from './use-onboarding-facts';
import { useOnboardingProgress } from './use-onboarding-progress';

interface OnboardingWizardProps {
  /**
   * Leave setup for the application: with no destination for the page the
   * person was heading to when setup interrupted them, or with one when a step
   * sends them somewhere of its own.
   */
  readonly onDone: (destination?: string) => void;
}

export function OnboardingWizard({ onDone }: OnboardingWizardProps) {
  const { t } = useI18n();
  const s = t.onboarding;
  const progress = useOnboardingProgress();
  const { signOut, isSigningOut } = useSignOut();
  const facts = useOnboardingFacts(progress.state);
  const [step, setStep] = useState<OnboardingStepId | null>(null);
  // A step can be about to write the same record these buttons write. `isSaving`
  // only covers a write already in flight, and the first-chat step creates a
  // chat before it stores the id — a window this closes.
  const [isStepWriting, setStepWriting] = useState(false);
  const isWriting = progress.isSaving || isStepWriting;

  const state = progress.state;
  const statuses = onboardingStepStatuses(state, facts);
  const environmentId = state.environmentId ?? LOCAL_ENVIRONMENT_ID;
  const resume = resumeOnboarding(state, facts);

  // Resume positions the flow exactly once. After that the person is driving,
  // and moving them because a poll landed would take the wizard away from them
  // mid-sentence.
  if (step === null && !progress.isLoading) {
    if (resume.kind === 'step') setStep(resume.step);
    if (resume.kind === 'done') setStep('chat');
  }

  // Progress is the one thing nothing can proceed without: no step can be
  // judged against it, and no write can be built on top of it, until it is
  // here. A machine fact that has not arrived is a different matter — see the
  // panel below, which keeps the chrome standing around it.
  if (progress.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-3 bg-canvas">
        <Spinner size="lg" />
        <span className="text-sm text-fg-muted">{s.deciding}</span>
      </div>
    );
  }

  const index = step === null ? -1 : ONBOARDING_STEP_IDS.indexOf(step);
  const isLast = index === ONBOARDING_STEP_IDS.length - 1;
  const advance = () => {
    const next = ONBOARDING_STEP_IDS[index + 1];
    if (next) setStep(next);
  };

  // One primary per region. While a step still has an action of its own to
  // take (choose the folder, send the first prompt), that action is the
  // primary and Continue steps down to `secondary`: it is enabled either way,
  // because setup is skippable at every step, but it is not what the step is
  // asking for. Every other step has no action of its own, so Continue is it.
  const stepOwnsPrimary =
    (step === 'folder' && !state.workdir) ||
    (step === 'chat' && !!state.workdir && statuses.chat !== 'satisfied');

  // Skipping a step is for a step that is asking something of the person and
  // has not been answered. The welcome step asks nothing (Continue is "Get
  // started"; skipping an introduction means nothing), and a satisfied one has
  // nothing left to skip: offering it would only record "skipped" over "done".
  const canSkipStep = step !== null && step !== 'welcome' && statuses[step] !== 'satisfied';

  const complete = async (destination?: string) => {
    await progress.update((current) => ({ ...current, completedAt: Date.now() }));
    onDone(destination);
  };

  const skipCurrent = async () => {
    if (step === null) return;
    await progress.update((current) => ({
      ...current,
      skippedSteps: [...current.skippedSteps.filter((id) => id !== step), step],
    }));
    if (isLast) {
      await complete();
      return;
    }
    advance();
  };

  const continueFromStep = async () => {
    if (step === null) return;
    if (step === 'welcome') {
      await progress.update((current) => ({ ...current, welcomeAcknowledged: true }));
    }
    if (isLast) {
      await complete();
      return;
    }
    advance();
  };

  return (
    <div className="min-h-screen bg-canvas px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <header className="space-y-2 text-center">
          {/* The only page a not-yet-configured account can reach, so the way
              back out of the wrong account has to be on it. Skipping the whole
              setup is the other account-level exit, so the two sit together
              instead of one floating under a card whose height changes with
              every step.

              Guarded like Continue: both write the same record, and a second
              click while the first write is open builds its update on the value
              the first one has not replaced yet. */}
          <div className="flex items-center justify-end gap-1">
            <Button
              type="button"
              variant="subtle"
              size="sm"
              data-testid="onboarding-skip-all"
              disabled={isWriting}
              onClick={() => void complete()}
            >
              {s.skipAll}
            </Button>
            <Button
              variant="subtle"
              size="sm"
              data-testid="logout-button"
              loading={isSigningOut}
              onClick={() => void signOut()}
            >
              {isSigningOut ? t.auth.logoutLoading : t.auth.logoutButton}
            </Button>
          </div>
          <Logo className="mx-auto size-12" />
          <h1 className="text-title font-semibold text-fg">{s.title}</h1>
        </header>

        <div className="grid gap-6 sm:grid-cols-[13rem_1fr]">
          {/* From `sm` up only. A phone has no room for six steps in a row, and
              a strip that scrolls sideways hides the current one at its edge;
              the card says which step this is, by number and by name, and Back,
              Skip and Continue move through them. */}
          <nav aria-label={s.stepList} className="hidden sm:block">
            <ol className="flex flex-col gap-1">
              {ONBOARDING_STEP_IDS.map((candidate, position) => (
                <li key={candidate}>
                  <button
                    type="button"
                    aria-current={candidate === step ? 'step' : undefined}
                    data-testid={`onboarding-step-${candidate}`}
                    onClick={() => setStep(candidate)}
                    className={cn(
                      'relative flex h-8 w-full items-center justify-between gap-2 rounded-sm px-3 text-left text-sm transition-colors',
                      // The same current-item signal as the sidebar.
                      candidate === step
                        ? cn('bg-fill-selected font-medium text-fg', SELECTION_BAR)
                        : 'text-fg-muted hover:bg-fill-hover hover:text-fg'
                    )}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="font-mono text-micro text-fg-subtle">{position + 1}</span>
                      <span className="truncate">{s.steps[candidate]}</span>
                    </span>
                    <StepStatusChip status={statuses[candidate]} />
                  </button>
                </li>
              ))}
            </ol>
          </nav>

          {/* `min-w-0`: a grid item defaults to `min-width: auto`, so a long path
              or command inside a step would widen the column past the viewport
              instead of wrapping. */}
          <Card className="min-w-0 space-y-6">
            {/* No step chosen means resume is still waiting on a fact. The
                wizard says so here rather than in place of the whole page: a
                probe that keeps failing never answers, and the only exits a
                half-configured account has are the ones around this panel. */}
            {step === null ? (
              <div className="flex items-center gap-3 py-6" data-testid="onboarding-deciding">
                <Spinner size="lg" />
                <span className="text-sm text-fg-muted">{s.deciding}</span>
              </div>
            ) : (
              // From `sm` up the step list beside the card already marks the current
              // step; the line is for the phone, which has no list. Hidden rather
              // than removed, so the card's `space-y` leaves no gap above the title.
              <p className="font-mono text-micro text-fg-subtle sm:hidden">
                {formatMessage(s.progress, {
                  step: String(index + 1),
                  total: String(ONBOARDING_STEP_IDS.length),
                  name: s.steps[step],
                })}
              </p>
            )}

            {step === 'welcome' ? <WelcomeStep /> : null}
            {step === 'folder' ? (
              <FolderStep state={state} onChange={progress.update} isSaving={isWriting} />
            ) : null}
            {step === 'toolchain' ? <ToolchainStep environmentId={environmentId} /> : null}
            {step === 'agents' ? (
              <AgentsStep
                environmentId={environmentId}
                state={state}
                onChange={progress.update}
                isSaving={isWriting}
              />
            ) : null}
            {step === 'service' ? <ServiceStep /> : null}
            {step === 'chat' ? (
              <FirstChatStep
                environmentId={environmentId}
                state={state}
                onChange={progress.update}
                answered={facts.chat === 'satisfied'}
                onOpenChat={() => complete('/')}
                onWritingChange={setStepWriting}
                onGoToFolder={() => setStep('folder')}
              />
            ) : null}

            {progress.saveFailed ? (
              <Callout tone="danger" data-testid="onboarding-save-failed">
                {s.saveFailed}
              </Callout>
            ) : null}

            {step === null ? null : (
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-stroke pt-4">
                {/* One row, one height: Back and Skip share Continue's `lg`, or
                    the secondary's border sits visibly inside the primary's box.
                    Nothing precedes the first step, so there is nothing to go
                    back to: no disabled placeholder. */}
                {index > 0 ? (
                  <Button
                    variant="secondary"
                    size="lg"
                    data-testid="onboarding-back"
                    onClick={() => {
                      const previous = ONBOARDING_STEP_IDS[index - 1];
                      if (previous) setStep(previous);
                    }}
                  >
                    {s.back}
                  </Button>
                ) : null}
                {canSkipStep ? (
                  <Button
                    variant="subtle"
                    size="lg"
                    data-testid="onboarding-skip-step"
                    disabled={isWriting}
                    onClick={() => void skipCurrent()}
                  >
                    {s.skipStep}
                  </Button>
                ) : null}
                <Button
                  variant={stepOwnsPrimary ? 'secondary' : 'primary'}
                  size="lg"
                  data-testid="onboarding-continue"
                  loading={isWriting}
                  onClick={() => void continueFromStep()}
                >
                  {step === 'welcome' ? s.welcome.action : isLast ? s.finish : s.continue}
                </Button>
              </div>
            )}
          </Card>
        </div>

        {/* The first chat is a real send, so it meets the same two consents any
            other send does — and they are answered with the same dialogs, not
            with a second copy of them written for this page. */}
        <ExternalWorkspaceTrustGate />
        <ExternalDisclosureGate />
      </div>
    </div>
  );
}
