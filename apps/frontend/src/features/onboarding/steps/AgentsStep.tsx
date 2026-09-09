/**
 * Who answers a chat: one of MangoStudio's own models, or an agent CLI already
 * installed on the chosen machine.
 *
 * Signing a vendor CLI in is deliberately not offered here. Those credentials
 * are the vendor's, entered in the vendor's own terminal, and the honest thing
 * a setup step can do is name the command and stay out of the way.
 */

import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { ExternalAgentDescriptor } from '@mangostudio/shared/external-agents';
import type { OnboardingState } from '@mangostudio/shared/onboarding';
import { useQuery } from '@tanstack/react-query';
import { Bot, Check, Sparkles } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { CopyLine } from '@/features/environments/components/CopyLine';
import {
  externalAgentSelectable,
  useExternalAgents,
} from '@/features/external-agents/useExternalAgents';
import { useI18n } from '@/hooks/use-i18n';
import { catalogQueryOptions } from '@/hooks/use-model-catalog';
import { StepFrame } from '../StepFrame';

interface AgentsStepProps {
  readonly environmentId: string;
  readonly state: OnboardingState;
  readonly onChange: (updater: (current: OnboardingState) => OnboardingState) => Promise<void>;
  /**
   * A write is already open. Picking again before it lands would build the
   * second update on the record the first has not replaced yet.
   */
  readonly isSaving: boolean;
}

const MANGOSTUDIO_RUNNER: ChatRunnerConfiguration = { kind: 'mangostudio', agentId: 'default' };

/**
 * Whether every agent here is refused for want of an isolated OS identity.
 *
 * All of them or none: isolation is a property of the machine, not of one
 * vendor, so a mix means something else is wrong with the ones that are
 * refused and the ordinary per-agent rendering is the honest answer.
 */
function isolationWithdrawn(agents: readonly ExternalAgentDescriptor[]): boolean {
  return agents.every((agent) => agent.unavailableReason === 'isolation-unproven');
}

function sameRunner(a: ChatRunnerConfiguration | undefined, b: ChatRunnerConfiguration): boolean {
  if (!a || a.kind !== b.kind) return false;
  return a.kind === 'mangostudio' ? true : a.targetId === (b as { targetId: string }).targetId;
}

export function AgentsStep({ environmentId, state, onChange, isSaving }: AgentsStepProps) {
  const { t } = useI18n();
  const s = t.onboarding.agents;
  const external = useExternalAgents(environmentId);
  // Loaded here rather than by the route: a catalog that cannot be read is one
  // of the things setup exists to fix, so it must not be able to stop this page
  // from rendering. A failure reads as "no model", which is what it means for
  // the choice on offer.
  const catalog = useQuery(catalogQueryOptions());
  const hasModel = (catalog.data?.textModels.length ?? 0) > 0;
  const choose = (runner: ChatRunnerConfiguration) =>
    void onChange((current) => ({ ...current, runner }));

  return (
    <StepFrame title={s.title} lead={s.lead} hint={s.hint}>
      <RunnerOption
        title={t.library.targets.mangostudio}
        description={s.modelDescription}
        icon={<Sparkles aria-hidden size={16} className="text-primary" />}
        selected={sameRunner(state.runner, MANGOSTUDIO_RUNNER)}
        disabled={isSaving || (!catalog.isPending && !hasModel)}
        testId="onboarding-runner-mangostudio"
        onSelect={() => choose(MANGOSTUDIO_RUNNER)}
      />

      {!catalog.isPending && !hasModel ? (
        <p className="text-on-surface-variant/70 text-sm" data-testid="onboarding-no-models">
          {s.noModels}
        </p>
      ) : null}

      <div className="space-y-2 pt-1">
        <p className="font-label font-semibold text-on-surface-variant text-xs uppercase tracking-wider">
          {s.cliHeading}
        </p>
        {external.isLoading ? (
          <div className="flex justify-center py-4">
            <Spinner size="md" />
          </div>
        ) : external.isError ? (
          // A refused probe and a machine with no CLIs on it both arrive as an
          // empty list. Only one of them is an answer, and telling the person
          // "none found" about the other sends them to install what they have.
          <p className="text-on-surface-variant text-sm" data-testid="onboarding-agents-failed">
            {s.probeFailed}
          </p>
        ) : external.agents.length === 0 ? (
          <p className="text-on-surface-variant/70 text-sm">{s.noneFound}</p>
        ) : isolationWithdrawn(external.agents) ? (
          // Local's agent sign-ins belong to the OS account the hub runs as.
          // Once a second person has an account here they are no longer this
          // person's to use, and pretending otherwise would offer a runner
          // every send would refuse.
          <p className="text-on-surface-variant text-sm" data-testid="onboarding-agents-isolated">
            {s.isolated}
          </p>
        ) : (
          external.agents.map((agent) => (
            <AgentOption
              key={agent.targetId}
              agent={agent}
              busy={isSaving}
              selected={sameRunner(state.runner, { kind: 'external', targetId: agent.targetId })}
              onSelect={() => choose({ kind: 'external', targetId: agent.targetId })}
            />
          ))
        )}
      </div>
    </StepFrame>
  );
}

function AgentOption({
  agent,
  busy,
  selected,
  onSelect,
}: {
  readonly agent: ExternalAgentDescriptor;
  readonly busy: boolean;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const { t } = useI18n();
  const s = t.onboarding.agents;
  const selectable = externalAgentSelectable(agent);

  return (
    <div className="space-y-2">
      <RunnerOption
        title={t.library.targets[agent.targetId]}
        description={agent.authState === 'signed-out' ? s.signedOut : s.signedIn}
        icon={<Bot aria-hidden size={16} className="text-primary" />}
        selected={selected}
        disabled={busy || !selectable}
        testId={`onboarding-runner-${agent.targetId}`}
        onSelect={onSelect}
      />
      {/* The command is the whole remedy, so it is shown rather than hidden
          behind a disabled control the user cannot learn anything from. */}
      {!selectable && agent.loginCommand ? (
        <div className="pl-1">
          <CopyLine label={s.signInHint} value={agent.loginCommand} />
        </div>
      ) : null}
    </div>
  );
}

function RunnerOption({
  title,
  description,
  icon,
  selected,
  disabled = false,
  testId,
  onSelect,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: React.ReactNode;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly testId: string;
  readonly onSelect: () => void;
}) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      disabled={disabled}
      data-testid={testId}
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        selected
          ? 'border-primary/40 bg-primary/5'
          : 'border-outline-variant/20 bg-surface-container-lowest/60 hover:bg-surface-container-high'
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-on-surface text-sm">{title}</span>
        <span className="block truncate text-on-surface-variant/70 text-xs">{description}</span>
      </span>
      {selected ? (
        <span className="flex shrink-0 items-center gap-1 font-semibold text-primary text-xs">
          <Check aria-hidden size={13} />
          {t.onboarding.agents.selected}
        </span>
      ) : null}
    </button>
  );
}
