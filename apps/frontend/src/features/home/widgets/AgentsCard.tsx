/**
 * Which harnesses this machine can actually run a turn with, and whether the
 * one this chat is pointed at still has quota.
 *
 * Reuses the discovery query the runner selector already holds, so the card
 * costs nothing on a warm cache. The quota read is scoped to the *active*
 * runner rather than fanned out across every installed agent: it is a cold
 * cache read per account, and asking four vendors what is left is four
 * subprocesses to answer a question about one.
 */

import type {
  ExternalAgentDescriptor,
  ExternalAgentTargetId,
} from '@mangostudio/shared/external-agents';
import type { Messages } from '@mangostudio/shared/i18n';
import { Link } from '@tanstack/react-router';
import { SectionCard } from '@/components/ui/SectionCard';
import { ExternalAccountLimitsChip } from '@/features/external-agents/ExternalAccountLimitsChip';
import { useExternalAccountLimits } from '@/features/external-agents/use-external-account-limits';
import { useExternalAgents } from '@/features/external-agents/useExternalAgents';
import { useI18n } from '@/hooks/use-i18n';
import { agentIdentityTokens } from '@/lib/agent-identity';
import { formatMessage } from '@/lib/i18n-format';
import { HubSkeletonLines } from './HubSkeletonLines';

interface AgentsCardProps {
  environmentId: string | null;
  /** The chat's runner, when it is an external one — decides whose quota shows. */
  activeTargetId?: ExternalAgentTargetId;
  /**
   * Sessions per harness over the reporting window, keyed the way
   * `runnerKey` keys them. Passed in rather than derived here so the card stays
   * a view of discovery: a chat-scoped surface has no reason to count sessions,
   * and the dashboard already holds the list to count them from.
   */
  sessionCounts?: Readonly<Record<string, number>>;
  className?: string;
}

const UNAVAILABLE_DOT: Readonly<Record<'warning' | 'error', string>> = {
  warning: 'bg-warning',
  error: 'bg-error',
};

export function AgentsCard({
  environmentId,
  activeTargetId,
  sessionCounts,
  className,
}: AgentsCardProps) {
  const { t } = useI18n();
  const labels = t.home.agents;
  const external = useExternalAgents(environmentId);
  const activeDescriptor = activeTargetId ? external.find(activeTargetId) : undefined;

  return (
    <SectionCard
      label={labels.label}
      tone="accent"
      className={className}
      action={
        <Link
          to="/environments/agents"
          className="micro-label text-primary/80 transition-colors hover:text-primary"
        >
          {labels.manage}
        </Link>
      }
    >
      {external.isLoading ? <HubSkeletonLines /> : null}

      {!external.isLoading && external.agents.length === 0 ? (
        <p className="text-xs text-on-surface-variant">{labels.empty}</p>
      ) : null}

      {external.agents.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {external.agents.map((agent) => (
            <li key={agent.targetId}>
              <AgentPill descriptor={agent} sessionCount={sessionCounts?.[agent.targetId]} />
            </li>
          ))}
        </ul>
      ) : null}

      {/* Only rendered for a vendor that reports account usage at all, and the
          chip itself stays quiet until the numbers say something. */}
      {activeDescriptor?.capabilities.accountUsage ? (
        <AgentQuotaLine descriptor={activeDescriptor} />
      ) : null}
    </SectionCard>
  );
}

function AgentPill({
  descriptor,
  sessionCount,
}: {
  descriptor: ExternalAgentDescriptor;
  sessionCount: number | undefined;
}) {
  const { t } = useI18n();
  const name = t.externalAgents.target[descriptor.targetId];
  const note = availabilityNote(descriptor, t);
  const problem = availabilityProblem(descriptor);
  // A harness with no session in the window is simply not annotated: "0 this
  // week" is a row of noughts across a fresh account's card, and the absence
  // says the same thing more quietly.
  const usage =
    sessionCount !== undefined && sessionCount > 0
      ? formatMessage(t.home.agents.sessionsThisWeek, { count: String(sessionCount) })
      : null;

  return (
    <span
      className={`terminal-chip h-6 max-w-full gap-1.5 ${problem ? 'opacity-70' : ''}`}
      title={note}
      data-testid="hub-agent-pill"
      data-target={descriptor.targetId}
      data-availability={problem ?? 'ok'}
    >
      {/* One dot, not two. It carries harness identity while the agent is
          usable and switches to the problem's colour when it is not — which is
          the only moment the identity colour has something more urgent to say.
          The words behind it are in the title and the sr-only span. */}
      <span
        aria-hidden="true"
        className={`inline-block size-1.5 shrink-0 rounded-full ${
          problem ? UNAVAILABLE_DOT[problem] : agentIdentityTokens(descriptor.targetId).dotClass
        }`}
      />
      {/* The harness name never truncates and the version always may: a vendor
          can report anything here (Claude answers `2.1.241 (Claude Code)`) and
          the pill was cutting "Claude Code" down to "Claude C…" to keep it. */}
      <span className="shrink-0 text-on-surface">{name}</span>
      {descriptor.version ? (
        <span className="min-w-0 truncate text-on-surface-variant/60">{descriptor.version}</span>
      ) : null}
      {usage ? (
        <span
          className="shrink-0 border-l border-outline-variant/20 pl-1.5 text-on-surface-variant/70"
          data-testid="hub-agent-sessions"
        >
          {usage}
        </span>
      ) : null}
      <span className="sr-only">{note}</span>
    </span>
  );
}

/**
 * The sentence behind the dot. Discovery normally states a reason for anything
 * unusable, but the two states it can leave implicit — not installed, signed
 * out — are spelled out here rather than falling through to "sign-in state
 * unknown", which would read as "fine" for an agent that is not.
 */
function availabilityNote(descriptor: ExternalAgentDescriptor, t: Messages): string {
  const labels = t.externalAgents;
  if (descriptor.unavailableReason) return labels.unavailable[descriptor.unavailableReason];
  if (!descriptor.installed) return labels.unavailable['not-installed'];
  if (descriptor.authState === 'signed-out') return labels.unavailable['signed-out'];
  return descriptor.authState === 'signed-in'
    ? labels.selector.signedIn
    : labels.selector.authUnknown;
}

function availabilityProblem(descriptor: ExternalAgentDescriptor): 'warning' | 'error' | null {
  // Clearable by the user, right here in the app: a warning, not a fault. Every
  // other reason needs an install, a login, or somebody else's change to a
  // machine, which is a different kind of stuck.
  if (descriptor.unavailableReason === 'disclosure-required') return 'warning';
  if (descriptor.unavailableReason || !descriptor.installed) return 'error';
  // `unknown` is not a verdict: Claude may keep credentials in an OS keychain,
  // so a missing credential file is not a signed-out agent — see
  // `externalAgentSelectable`.
  return descriptor.authState === 'signed-out' ? 'error' : null;
}

/**
 * Split out so the quota query is only mounted for a descriptor that has one:
 * `useExternalAccountLimits(null)` is inert, but a hook that runs on every
 * card render for every agent would still hold four cache entries.
 */
function AgentQuotaLine({ descriptor }: { descriptor: ExternalAgentDescriptor }) {
  const { limits, refreshing, refresh } = useExternalAccountLimits(descriptor);
  return <ExternalAccountLimitsChip limits={limits} refreshing={refreshing} onRefresh={refresh} />;
}
