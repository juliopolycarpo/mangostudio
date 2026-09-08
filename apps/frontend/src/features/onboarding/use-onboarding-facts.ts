/**
 * The live half of first-run setup: what the machine says right now.
 *
 * Nothing here is remembered. Every step's answer is read from the same
 * surfaces the rest of the application reads, so a toolchain uninstalled, an
 * agent signed out or a folder deleted after the fact sends the person back to
 * that step instead of leaving a stale tick beside it.
 *
 * A query that has not answered yet reports `unknown`, never `unsatisfied` —
 * reading a pending request as an empty machine is what would make a reload
 * drag someone backwards through steps they finished.
 *
 * // Usage: const facts = useOnboardingFacts(state);
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import type {
  OnboardingFact,
  OnboardingMachineFacts,
  OnboardingState,
} from '@mangostudio/shared/onboarding';
import { useQuery } from '@tanstack/react-query';
import { useMessagesQuery } from '@/features/chat/queries';
import { useMachineStatus } from '@/features/environments/machine/queries';
import {
  runtimeStatusesQueryOptions,
  useEnvironmentEntitiesQuery,
} from '@/features/environments/queries';
import {
  externalAgentSelectable,
  useExternalAgents,
} from '@/features/external-agents/useExternalAgents';

/** Runtimes a coding agent needs to run anything in a project. Either one is enough. */
const PROJECT_RUNTIME_IDS = ['node', 'bun'] as const;

function factOf(isPending: boolean, isError: boolean, satisfied: () => boolean): OnboardingFact {
  if (isPending) return 'unknown';
  // A failed probe is not a missing toolchain. Saying so would send someone to
  // install what they already have because one request was refused.
  if (isError) return 'unknown';
  return satisfied() ? 'satisfied' : 'unsatisfied';
}

export function useOnboardingFacts(state: OnboardingState): OnboardingMachineFacts {
  const environments = useEnvironmentEntitiesQuery();
  const environmentId = state.environmentId ?? LOCAL_ENVIRONMENT_ID;

  const runtimes = useQuery(runtimeStatusesQueryOptions(environmentId));
  const machine = useMachineStatus();
  const agents = useExternalAgents(environmentId);
  const messages = useMessagesQuery(state.chatId ?? null);

  const folder = factOf(
    environments.isPending,
    environments.isError,
    () =>
      state.workdir !== undefined &&
      (environments.data ?? []).some((environment) => environment.id === environmentId)
  );

  const toolchain = factOf(runtimes.isPending, runtimes.isError, () =>
    (runtimes.data ?? []).some(
      (runtime) =>
        (PROJECT_RUNTIME_IDS as readonly string[]).includes(runtime.id) &&
        (runtime.health === 'ok' || runtime.health === 'warn')
    )
  );

  const agentFact = factOf(agents.isLoading, false, () => {
    const runner = state.runner;
    if (!runner) return false;
    // A MangoStudio runner needs no CLI, so choosing one settles this step.
    // An external one has to still be usable — an agent signed out since the
    // choice was made is exactly what should reopen this step.
    if (runner.kind === 'mangostudio') return true;
    const descriptor = agents.find(runner.targetId);
    return descriptor !== undefined && externalAgentSelectable(descriptor);
  });

  const service = serviceFact(machine);

  const chat = factOf(
    state.chatId !== undefined && messages.isPending,
    messages.isError,
    () =>
      state.chatId !== undefined &&
      (messages.data?.pages ?? []).some((page) =>
        page.messages.some(
          (message) => message.role === 'ai' && !message.isGenerating && message.text.length > 0
        )
      )
  );

  return { folder, toolchain, agents: agentFact, service, chat };
}

/**
 * Whether the hub already survives a logout.
 *
 * The machine surface answers three different things through one document, and
 * they mean different things here: an installed unit satisfies the step, a
 * refused action means the browser is not on the hub's own computer (or the
 * platform has no supervisor) and the step is not actionable at all, and
 * anything else is a real "not yet".
 */
function serviceFact(machine: ReturnType<typeof useMachineStatus>): OnboardingFact {
  if (machine.isPending) return 'unknown';
  const status = machine.data;
  if (!status) return 'unknown';
  if (status.service.installed) return 'satisfied';
  return status.actions.installService.available ? 'unsatisfied' : 'unavailable';
}
