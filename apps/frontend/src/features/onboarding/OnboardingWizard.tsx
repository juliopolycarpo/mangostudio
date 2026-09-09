/**
 * First-run setup, end to end.
 *
 * Every action here is one the rest of the application already offers — a
 * folder picker, the environment manager, the runner selector, the service
 * card, a chat. What this adds is an order, a reason for each step, and the
 * memory to leave and come back. Nothing is only reachable from here, which is
 * why skipping is offered on every step and costs nothing.
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
import { Logo } from '@/components/ui/Logo';
import { Spinner } from '@/components/ui/Spinner';
import { ExternalDisclosureGate } from '@/features/external-agents/ExternalDisclosureGate';
import { ExternalWorkspaceTrustGate } from '@/features/external-agents/ExternalWorkspaceTrustGate';
import { useI18n } from '@/hooks/use-i18n';
import { useSignOut } from '@/hooks/use-sign-out';
import { formatMessage } from '@/lib/i18n-format';
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
      <div className="flex min-h-screen items-center justify-center gap-3 bg-surface-dim">
        <Spinner size="lg" />
        <span className="text-on-surface-variant text-sm">{s.deciding}</span>
      </div>
    );
  }

  const index = step === null ? -1 : ONBOARDING_STEP_IDS.indexOf(step);
  const isLast = index === ONBOARDING_STEP_IDS.length - 1;
  const advance = () => {
    const next = ONBOARDING_STEP_IDS[index + 1];
    if (next) setStep(next);
  };

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
    <div className="min-h-screen bg-surface-dim px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <header className="space-y-2 text-center">
          {/* The only page a not-yet-configured account can reach, so the way
              back out of the wrong account has to be on it. */}
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              data-testid="logout-button"
              loading={isSigningOut}
              onClick={() => void signOut()}
            >
              {isSigningOut ? t.auth.logoutLoading : t.auth.logoutButton}
            </Button>
          </div>
          <Logo className="mx-auto size-14" />
          <h1 className="font-headline font-bold text-2xl text-on-surface">{s.title}</h1>
          <p className="mx-auto max-w-xl text-on-surface-variant text-sm">{s.subtitle}</p>
        </header>

        <div className="grid gap-5 sm:grid-cols-[13rem_1fr]">
          {/* `min-w-0` on both tracks: a grid item defaults to `min-width:
              auto`, so the horizontally scrolling step list below would widen
              its own column past the viewport and take the panel with it. */}
          <nav aria-label={s.stepList} className="min-w-0">
            <ol className="flex gap-1.5 overflow-x-auto sm:flex-col sm:overflow-visible">
              {ONBOARDING_STEP_IDS.map((candidate, position) => (
                <li key={candidate} className="shrink-0 sm:shrink">
                  <button
                    type="button"
                    aria-current={candidate === step ? 'step' : undefined}
                    data-testid={`onboarding-step-${candidate}`}
                    onClick={() => setStep(candidate)}
                    className={`flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left transition-colors ${
                      candidate === step
                        ? 'bg-surface-container-high text-on-surface'
                        : 'text-on-surface-variant hover:bg-surface-container-high/60'
                    }`}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="font-mono text-on-surface-variant/50 text-xs">
                        {position + 1}
                      </span>
                      <span className="truncate font-semibold text-sm">{s.steps[candidate]}</span>
                    </span>
                    <StepStatusChip status={statuses[candidate]} />
                  </button>
                </li>
              ))}
            </ol>
          </nav>

          <section className="min-w-0 space-y-6 rounded-3xl border border-outline-variant/20 bg-surface-container-high p-5 sm:p-7">
            {/* No step chosen means resume is still waiting on a fact. The
                wizard says so here rather than in place of the whole page: a
                probe that keeps failing never answers, and the only exits a
                half-configured account has are the ones around this panel. */}
            {step === null ? (
              <div className="flex items-center gap-3 py-6" data-testid="onboarding-deciding">
                <Spinner size="lg" />
                <span className="text-on-surface-variant text-sm">{s.deciding}</span>
              </div>
            ) : (
              <p className="font-label text-on-surface-variant/60 text-xs uppercase tracking-widest">
                {formatMessage(s.progress, {
                  step: String(index + 1),
                  total: String(ONBOARDING_STEP_IDS.length),
                })}
              </p>
            )}

            {step === 'welcome' ? <WelcomeStep /> : null}
            {step === 'folder' ? (
              <FolderStep state={state} onChange={progress.update} isSaving={progress.isSaving} />
            ) : null}
            {step === 'toolchain' ? <ToolchainStep environmentId={environmentId} /> : null}
            {step === 'agents' ? (
              <AgentsStep
                environmentId={environmentId}
                state={state}
                onChange={progress.update}
                isSaving={progress.isSaving}
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
              />
            ) : null}

            {progress.saveFailed ? (
              <p className="text-error text-sm" data-testid="onboarding-save-failed">
                {s.saveFailed}
              </p>
            ) : null}

            {step === null ? null : (
              <div className="flex flex-wrap items-center justify-between gap-3 border-outline-variant/15 border-t pt-4">
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={index === 0}
                    data-testid="onboarding-back"
                    onClick={() => {
                      const previous = ONBOARDING_STEP_IDS[index - 1];
                      if (previous) setStep(previous);
                    }}
                  >
                    {s.back}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="onboarding-skip-step"
                    disabled={progress.isSaving}
                    onClick={() => void skipCurrent()}
                  >
                    {s.skipStep}
                  </Button>
                </div>

                <Button
                  data-testid="onboarding-continue"
                  loading={progress.isSaving}
                  onClick={() => void continueFromStep()}
                >
                  {step === 'welcome' ? s.welcome.action : isLast ? s.finish : s.continue}
                </Button>
              </div>
            )}
          </section>
        </div>

        {/* The first chat is a real send, so it meets the same two consents any
            other send does — and they are answered with the same dialogs, not
            with a second copy of them written for this page. */}
        <ExternalWorkspaceTrustGate />
        <ExternalDisclosureGate />

        <div className="text-center">
          {/* Guarded like Continue: both write the same record, and a second
              click while the first write is open builds its update on the value
              the first one has not replaced yet. */}
          <button
            type="button"
            data-testid="onboarding-skip-all"
            disabled={progress.isSaving}
            onClick={() => void complete()}
            className="text-on-surface-variant/60 text-xs underline underline-offset-4 hover:text-on-surface-variant"
          >
            {s.skipAll}
          </button>
        </div>
      </div>
    </div>
  );
}
