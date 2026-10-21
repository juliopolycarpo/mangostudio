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
import { useId } from 'react';
import { PickOneRow } from '@/components/settings/PickOneRow';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { Spinner } from '@/components/ui/Spinner';
import { StatusDot } from '@/components/ui/StatusDot';
import { CopyLine } from '@/features/environments/components/CopyLine';
import {
  externalAgentSelectable,
  useExternalAgents,
} from '@/features/external-agents/useExternalAgents';
import { useI18n } from '@/hooks/use-i18n';
import { catalogQueryOptions } from '@/hooks/use-model-catalog';
import { agentIdentityTokens, MANGO_IDENTITY } from '@/lib/agent-identity';
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

/**
 * The runner's identity dot, centred in the 16px slot every `PickOneRow` glyph
 * takes, so the names line up with the other pick-one lists. Always at full
 * strength: being unusable never replaces who is being described.
 */
function IdentityDot({ dotClassName }: { readonly dotClassName: string }) {
  return (
    <span className="flex size-4 items-center justify-center">
      <StatusDot tone="neutral" className={dotClassName} />
    </span>
  );
}

export function AgentsStep({ environmentId, state, onChange, isSaving }: AgentsStepProps) {
  const { t } = useI18n();
  const s = t.onboarding.agents;
  const groupName = useId();
  const external = useExternalAgents(environmentId);
  // Loaded here rather than by the route: a catalog that cannot be read is one
  // of the things setup exists to fix, so it must not be able to stop this page
  // from rendering. A failure reads as "no model", which is what it means for
  // the choice on offer.
  // Setup has no bootstrap panel to retry through, so a catalog that failed is
  // asked for again whenever this step mounts.
  const catalog = useQuery({ ...catalogQueryOptions(), retryOnMount: true });
  const hasModel = (catalog.data?.textModels.length ?? 0) > 0;
  const noModel = !catalog.isPending && !hasModel;
  // A write in flight refuses the pick rather than disabling the rows: it is
  // over in a moment, and a disabled row reads as a runner that cannot be used.
  // The radios are controlled, so a refused pick leaves the current one checked.
  // Nothing is checked until a runner is stored: the step is settled by the
  // stored choice, and a row that looked chosen before then would say otherwise.
  const choose = (runner: ChatRunnerConfiguration) => {
    if (isSaving) return;
    void onChange((current) => ({ ...current, runner }));
  };

  return (
    <StepFrame title={s.title} lead={s.lead} hint={s.hint}>
      {/* One choice across both lists: the radios share a name, so the arrow
          keys walk from MangoStudio into the agent CLIs, and the group is named
          by the question the step asks. */}
      <div role="radiogroup" aria-label={s.title} aria-busy={isSaving} className="space-y-4">
        <PickOneRow
          name={groupName}
          checked={sameRunner(state.runner, MANGOSTUDIO_RUNNER)}
          disabled={noModel}
          onSelect={() => choose(MANGOSTUDIO_RUNNER)}
          icon={<IdentityDot dotClassName={MANGO_IDENTITY.dotClass} />}
          title={t.library.targets.mangostudio}
          description={s.modelDescription}
          testId="onboarding-runner-mangostudio"
        />

        {noModel ? (
          <Callout tone="warning" data-testid="onboarding-no-models">
            {s.noModels}
          </Callout>
        ) : null}

        <div className="space-y-2 pt-1">
          <MicroLabel as="p">{s.cliHeading}</MicroLabel>
          {external.isLoading ? (
            <div className="flex justify-center py-4">
              <Spinner size="md" label={t.common.loading} />
            </div>
          ) : external.isError ? (
            // A refused probe and a machine with no CLIs on it both arrive as an
            // empty list. Only one of them is an answer, and telling the person
            // "none found" about the other sends them to install what they have.
            <Callout tone="warning" data-testid="onboarding-agents-failed">
              {s.probeFailed}
            </Callout>
          ) : external.agents.length === 0 ? (
            <p className="text-sm text-fg-muted">{s.noneFound}</p>
          ) : isolationWithdrawn(external.agents) ? (
            // Local's agent sign-ins belong to the OS account the hub runs as.
            // Once a second person has an account here they are no longer this
            // person's to use, and pretending otherwise would offer a runner
            // every send would refuse.
            <Callout tone="info" data-testid="onboarding-agents-isolated">
              {s.isolated}
            </Callout>
          ) : (
            <ul className="space-y-2">
              {external.agents.map((agent) => (
                <AgentOption
                  key={agent.targetId}
                  agent={agent}
                  groupName={groupName}
                  checked={sameRunner(state.runner, {
                    kind: 'external',
                    targetId: agent.targetId,
                  })}
                  onSelect={() => choose({ kind: 'external', targetId: agent.targetId })}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </StepFrame>
  );
}

/**
 * One agent CLI on offer: its identity dot, its name, and a badge for whether
 * it is signed in. Signed out is `warning`, the state the person can fix
 * (patterns.md, Status), and the row it disables keeps its dot and its name
 * readable (decision 17) because it is the one they have to act on.
 */
function AgentOption({
  agent,
  groupName,
  checked,
  onSelect,
}: {
  readonly agent: ExternalAgentDescriptor;
  readonly groupName: string;
  readonly checked: boolean;
  readonly onSelect: () => void;
}) {
  const { t } = useI18n();
  const s = t.onboarding.agents;
  const selectable = externalAgentSelectable(agent);
  const signedOut = agent.authState === 'signed-out';

  return (
    <li>
      <PickOneRow
        name={groupName}
        checked={checked}
        disabled={!selectable}
        onSelect={onSelect}
        icon={<IdentityDot dotClassName={agentIdentityTokens(agent.targetId).dotClass} />}
        title={
          <span className="flex items-center gap-1.5">
            <span className="truncate">{t.library.targets[agent.targetId]}</span>
            <Badge variant={signedOut ? 'warning' : 'success'}>
              {signedOut ? s.signedOut : s.signedIn}
            </Badge>
          </span>
        }
        testId={`onboarding-runner-${agent.targetId}`}
      />
      {/* The command is the whole remedy, so it is shown rather than hidden
          behind a disabled control the user cannot learn anything from. It
          belongs to this row alone — outside its label, nested under it and
          indented to its name, so the row names the agent and the hint need
          not — because Codex may be listed above the Claude Code row it is for. */}
      {!selectable && agent.loginCommand ? (
        <div className="pt-2 pl-10">
          <CopyLine label={s.signInHint} value={agent.loginCommand} />
        </div>
      ) : null}
    </li>
  );
}
