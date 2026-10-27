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

import { Badge } from '@/components/ui/Badge';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatusDot } from '@/components/ui/StatusDot';
import { ExternalAccountLimitsChip } from '@/features/external-agents/ExternalAccountLimitsChip';
import { useExternalAccountLimits } from '@/features/external-agents/use-external-account-limits';
import { useExternalAgents } from '@/features/external-agents/useExternalAgents';
import { useI18n } from '@/hooks/use-i18n';
import { agentIdentityTokens } from '@/lib/agent-identity';
import { formatMessage } from '@/lib/i18n-format';

import { CARD_LINK_CLASS } from './card-link';
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
      tone="neutral"
      className={className}
      action={
        <Link to="/environments/agents" className={CARD_LINK_CLASS}>
          {labels.manage}
        </Link>
      }
    >
      {external.isLoading ? <HubSkeletonLines /> : null}

      {!external.isLoading && external.agents.length === 0 ? (
        <p className="text-xs text-fg-muted">{labels.empty}</p>
      ) : null}

      {external.agents.length > 0 ? (
        <ul>
          {external.agents.map((agent) => (
            <AgentRow
              key={agent.targetId}
              descriptor={agent}
              sessionCount={sessionCounts?.[agent.targetId]}
            />
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

/**
 * One harness as a 32px row, laid out like a machine in `MachinesCard`: its
 * identity and version on the left, its state on the right as a `Badge` — a
 * word in a pill, never colour or a glyph alone.
 */
function AgentRow({
  descriptor,
  sessionCount,
}: {
  descriptor: ExternalAgentDescriptor;
  sessionCount: number | undefined;
}) {
  const { t } = useI18n();
  const name = t.externalAgents.target[descriptor.targetId];
  const note = availabilityNote(descriptor, t);
  const status = availabilityStatus(descriptor, t.home.agents);
  const version = descriptor.version ? displayVersion(descriptor.version, name) : null;
  // A harness with no session in the window is simply not annotated: "0 this
  // week" is a column of noughts across a fresh account's card, and the absence
  // says the same thing more quietly.
  const usage =
    sessionCount !== undefined && sessionCount > 0
      ? formatMessage(t.home.agents.sessionsThisWeek, { count: String(sessionCount) })
      : null;

  return (
    <li
      className="flex h-8 min-w-0 items-center gap-2 text-sm"
      title={note}
      data-testid="hub-agent-pill"
      data-target={descriptor.targetId}
      data-availability={status.variant}
    >
      {/* The dot is the harness's identity and only that, in every state: the
          same hue the sidebar and the composer know it by. The state is told by
          the badge at the end of the row, so status never replaces who is
          being described. */}
      <StatusDot tone="neutral" className={agentIdentityTokens(descriptor.targetId).dotClass} />
      {/* The harness name never truncates and the version always may: a vendor
          can report anything here (Claude answers `2.1.241 (Claude Code)`) and
          the row was cutting "Claude Code" down to "Claude C…" to keep it. */}
      <span className="shrink-0 text-fg">{name}</span>
      {version ? (
        <span className="min-w-0 truncate font-mono text-micro text-fg-muted">{version}</span>
      ) : null}
      {/* Allowed to shrink, with the usage figure giving way before the badge
          does: a long state word in Portuguese must not push the row past the
          card on a phone. */}
      <span className="ml-auto flex min-w-0 items-center gap-2">
        {usage ? (
          <span className="truncate text-xs text-fg-muted" data-testid="hub-agent-sessions">
            {usage}
          </span>
        ) : null}
        {/* The sentence behind the word is read out through the note below: some
            reasons are a whole clause long ("This machine runs a version that
            cannot host it"), which a badge cannot hold. */}
        <Badge variant={status.variant} aria-hidden="true">
          {status.word}
        </Badge>
      </span>
      <span className="sr-only">{note}</span>
    </li>
  );
}

/**
 * The version as a person reads it. Claude answers `2.1.241 (Claude Code)`, and
 * next to the name "Claude Code" the parenthetical says it twice. Only a
 * parenthetical that repeats the displayed name goes: `1.2.3 (beta)` is
 * information and stays.
 */
function displayVersion(version: string, name: string): string {
  const match = /^(.*\S)\s*\(([^()]*)\)$/.exec(version.trim());
  if (!match || match[2]?.trim().toLowerCase() !== name.toLowerCase()) return version;
  return match[1] ?? version;
}

/**
 * The sentence behind the badge. Discovery normally states a reason for
 * anything unusable, but the two states it can leave implicit — not installed,
 * signed out — are spelled out here rather than falling through to "sign-in
 * state unknown", which would read as "fine" for an agent that is not.
 */
function availabilityNote(descriptor: ExternalAgentDescriptor, t: Messages): string {
  const labels = t.externalAgents;
  if (descriptor.unavailableReason) return labels.unavailable[descriptor.unavailableReason];
  if (!descriptor.installed) return labels.unavailable['not-installed'];
  if (descriptor.authState === 'signed-out') return labels.unavailable['signed-out'];
  if (descriptor.discoveryState === 'undetermined') return labels.selector.discoveryUndetermined;
  return descriptor.authState === 'signed-in'
    ? labels.selector.signedIn
    : labels.selector.authUnknown;
}

interface AvailabilityStatus {
  readonly variant: 'success' | 'neutral' | 'warning' | 'error';
  readonly word: string;
}

/**
 * The state of one harness as the badge draws it: a word, and the tone that
 * says how much it matters (patterns.md, Notices and Unavailable).
 *
 * - `neutral`: not installed. A standing fact about the machine, and an optional
 *   CLI that is simply absent is not a fault, so a healthy account's Home does
 *   not show red for it.
 * - `warning`: signed out, needs approval, unconfirmed. The person can fix each
 *   one — sign in from a terminal, accept the notice here, run the probe again.
 * - `error`: any other reason the harness cannot run (an unreachable machine,
 *   a runtime that cannot host it, a version it refuses). Those need somebody
 *   else's change to a machine, which is a different kind of stuck.
 * - `success`: it can take a turn. `unknown` sign-in is not a verdict: Claude
 *   may keep credentials in an OS keychain, so a missing credential file is not
 *   a signed-out agent — see `externalAgentSelectable`.
 *
 * A stated reason is read before anything inferred from `installed`: an
 * unreachable machine reports nothing installed, and "Not installed" would be
 * a guess about a machine nobody could ask.
 */
function availabilityStatus(
  descriptor: ExternalAgentDescriptor,
  labels: Messages['home']['agents']
): AvailabilityStatus {
  const reason = descriptor.unavailableReason;
  if (reason === 'not-installed') return { variant: 'neutral', word: labels.notInstalled };
  if (reason === 'signed-out') return { variant: 'warning', word: labels.signedOut };
  if (reason === 'disclosure-required') return { variant: 'warning', word: labels.needsApproval };
  if (reason) return { variant: 'error', word: labels.unavailable };
  if (!descriptor.installed) return { variant: 'neutral', word: labels.notInstalled };
  if (descriptor.authState === 'signed-out') return { variant: 'warning', word: labels.signedOut };
  if (descriptor.discoveryState === 'undetermined') {
    return { variant: 'warning', word: labels.unconfirmed };
  }
  return { variant: 'success', word: labels.ready };
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
