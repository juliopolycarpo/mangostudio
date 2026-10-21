/**
 * Who runs this chat's turns.
 *
 * The header used to name a model. It now names a runner, because with an
 * external agent the model is the vendor's business and the only thing the user
 * is really choosing is whose software runs the turn. The model picker moved to
 * the composer, where it renders only when the active runner actually has a
 * catalog.
 *
 * Two groups, and one rule that shapes the whole component: **a chat has one
 * runner for life**. D14 made the *kind* immutable — a transcript that mixed
 * owners would replay a vendor's assistant text to MangoStudio's own model as
 * its own prior output — and the first prompt now settles the rest of the
 * choice too: once a chat has turns, *every* other runner (another agent,
 * another vendor) is offered as "continue in a new chat" rather than disabled
 * or — worse — silently switched.
 *
 * Nothing here renders an executable path. Discovery does not carry one.
 */

import type { AgentProfile } from '@mangostudio/shared/agents';
import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { EnvironmentTransportKind } from '@mangostudio/shared/environments';
import type {
  ExternalAgentDescriptor,
  ExternalAgentUnavailableReason,
} from '@mangostudio/shared/external-agents';
import type { Messages } from '@mangostudio/shared/i18n';
import {
  Check,
  ChevronDown,
  CircleX,
  CornerUpRight,
  History,
  Info,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { Spinner } from '@/components/ui/Spinner';
import { StatusDot } from '@/components/ui/StatusDot';
import { ExternalAccountLimitsChip } from '@/features/external-agents/ExternalAccountLimitsChip';
import { ExternalRemedyLink } from '@/features/external-agents/ExternalRemedyLink';
import { SignInCommand } from '@/features/external-agents/SignInCommand';
import { useExternalAccountLimits } from '@/features/external-agents/use-external-account-limits';
import {
  externalAgentSelectable,
  externalUnavailableText,
} from '@/features/external-agents/useExternalAgents';
import { useDismissable } from '@/hooks/use-dismissable';
import { useI18n } from '@/hooks/use-i18n';
import { agentIdentityTokens, MANGO_IDENTITY } from '@/lib/agent-identity';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

/** How loud the trigger's availability glyph is; `loading` is a wait, not a verdict. */
type AvailabilityCue = 'loading' | 'neutral' | 'warning' | 'error';

/**
 * How loud the trigger's availability glyph is for each reason an agent cannot
 * take a turn, by the product's severity ladder: absent and optional is neutral,
 * a thing the person can fix is warning, and error is for a fault. A healthy
 * account that simply has not installed Codex must not open on red in the header.
 *
 * Exhaustive on purpose: a reason added to the contract fails the build here
 * instead of defaulting to a colour nobody chose.
 */
const UNAVAILABLE_TONE: Record<
  ExternalAgentUnavailableReason,
  Exclude<AvailabilityCue, 'loading'>
> = {
  'not-installed': 'neutral',
  'runtime-unsupported': 'neutral',
  'signed-out': 'warning',
  'disclosure-required': 'warning',
  'version-unsupported': 'warning',
  'installed-but-unusable': 'warning',
  'runtime-denied': 'warning',
  'environment-unreachable': 'error',
  'isolation-unproven': 'error',
};

/**
 * The reason a descriptor is unusable when it names none: discovery reports an
 * agent that is not there, or is signed out, without a typed `unavailableReason`.
 */
function impliedUnavailableReason(
  descriptor: ExternalAgentDescriptor
): ExternalAgentUnavailableReason | undefined {
  if (descriptor.unavailableReason) return descriptor.unavailableReason;
  if (!descriptor.installed) return 'not-installed';
  if (descriptor.authState === 'signed-out') return 'signed-out';
  return undefined;
}

export interface RunnerSelectorProps {
  runner: ChatRunnerConfiguration;
  agents: ReadonlyArray<AgentProfile>;
  isAgentListLoading: boolean;
  externalAgents: readonly ExternalAgentDescriptor[];
  /**
   * True while discovery is still answering. Load-bearing for the trigger's glyph: a
   * missing descriptor and a refused one are the same shape, so without this an
   * unanswered query reads as "this agent cannot run here".
   */
  isExternalAgentListLoading?: boolean;
  /** The environment the descriptors describe, named in the unavailability copy. */
  environmentName: string;
  /**
   * How MangoStudio reaches that machine.
   *
   * Only used to pick which fix an `isolation-unproven` machine needs. The
   * server deliberately will not say why isolation failed — distinguishing
   * "attested nothing" from "attested a credential home somebody else reaches"
   * would confirm that another person uses the machine — so the actionable half
   * of that answer is derived here, from a transport the client already knows.
   */
  environmentTransportKind?: EnvironmentTransportKind;
  /** True once the chat has turns, which is what makes the runner immutable. */
  hasTurns: boolean;
  disabled?: boolean;
  onSelectAgent: (agentId: string) => void;
  onSelectExternal: (descriptor: ExternalAgentDescriptor) => void;
  /** Offered instead of a switch when the chat already has turns. */
  onForkWithRunner: (runner: ChatRunnerConfiguration) => void;
  /**
   * Opens the native-session picker.
   *
   * Always a new chat, so it is offered whether or not this one has turns:
   * adopting is not a runner switch, it is a different conversation whose
   * history belongs to the vendor.
   */
  onBrowseSessions: () => void;
}

export function RunnerSelector({
  runner,
  agents,
  isAgentListLoading,
  externalAgents,
  isExternalAgentListLoading = false,
  environmentName,
  environmentTransportKind,
  hasTurns,
  disabled = false,
  onSelectAgent,
  onSelectExternal,
  onForkWithRunner,
  onBrowseSessions,
}: RunnerSelectorProps) {
  const { t } = useI18n();
  const labels = t.externalAgents.selector;
  const [open, setOpen] = useState(false);
  const { containerRef, triggerRef, onKeyDown } = useDismissable(open, () => setOpen(false));

  // Exactly the filter the composer's agent picker already applies: a subagent
  // is not something a chat can be handed to.
  const selectableAgents = agents.filter(
    (agent) => agent.role === 'primary' || agent.role === 'both'
  );

  const activeLabel =
    runner.kind === 'mangostudio'
      ? (selectableAgents.find((agent) => agent.id === runner.agentId)?.name ?? runner.agentId)
      : // A target this bundle predates still names itself: its raw id beats a
        // blank trigger, and the sidebar badge already degrades the same way.
        (t.externalAgents.target[runner.targetId] ?? runner.targetId);

  // The trigger's dot says *who* runs the chat, in the runner's identity colour —
  // the same dot the sidebar, the palette and Home draw for it. Whether that runner
  // can take a turn right now is a separate glyph after the name, drawn only when
  // the answer is not "yes": MangoStudio always can, and an external runner grades
  // from signed-in (no glyph) through auth-unknown to not-selectable-here.
  const activeDescriptor =
    runner.kind === 'external'
      ? externalAgents.find((agent) => agent.targetId === runner.targetId)
      : undefined;
  // `disclosure-required` is checked on top of `externalAgentSelectable`, which
  // deliberately leaves such a descriptor selectable so the picker can route the
  // user into the notice. The trigger answers a different question — can this runner
  // take a turn right now — and the answer is no until the notice is accepted, so
  // a green dot reading "signed in" would promise a send that the turn-start gate
  // refuses. Same extra condition the composer applies.
  const activeUsable =
    !!activeDescriptor &&
    externalAgentSelectable(activeDescriptor) &&
    activeDescriptor.unavailableReason !== 'disclosure-required';
  // Tone and its screen-reader sentence are one decision, so they are made once:
  // splitting them into parallel ternaries is how the two drift.
  //
  // The unanswered-discovery arm comes first because a missing descriptor and a
  // refused one are indistinguishable here. Painting the refusal while the query
  // is still in flight told every reader "pick another agent" on every mount.
  //
  // An unusable agent grades by *why* (`UNAVAILABLE_TONE`) and says why, in the
  // selector's own sentence for that reason. Only an agent the environment does
  // not know at all, or one that names no reason, stays an error with the generic
  // line: nothing says it is merely absent or fixable.
  const unavailableReason = activeDescriptor
    ? impliedUnavailableReason(activeDescriptor)
    : undefined;
  const unusable: { cue: AvailabilityCue; text: string } = unavailableReason
    ? {
        cue: UNAVAILABLE_TONE[unavailableReason],
        text: externalUnavailableText(unavailableReason, t, activeDescriptor?.requiredVersion),
      }
    : { cue: 'error', text: labels.unavailableHere };
  // `cue: null` is a runner that is ready: no glyph, only the sentence for a
  // screen reader, so a healthy header carries no status colour at all.
  const availability: { cue: AvailabilityCue | null; text: string | null } =
    runner.kind === 'mangostudio'
      ? { cue: null, text: null }
      : !activeDescriptor && isExternalAgentListLoading
        ? { cue: 'loading', text: labels.loading }
        : !activeUsable
          ? unusable
          : activeDescriptor?.discoveryState === 'undetermined'
            ? { cue: 'warning', text: labels.discoveryUndetermined }
            : activeDescriptor?.authState === 'signed-in'
              ? { cue: null, text: labels.signedIn }
              : { cue: 'warning', text: labels.authUnknown };
  const identityDot =
    runner.kind === 'mangostudio'
      ? MANGO_IDENTITY.dotClass
      : agentIdentityTokens(runner.targetId).dotClass;
  // The trigger's name is its `aria-label` ("Who runs this chat"), which hides
  // anything written inside it; the availability sentence is its description.
  const availabilityId = useId();

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape is handled for the trigger and the panel it owns, both inside this wrapper.
    <div ref={containerRef} onKeyDown={onKeyDown} className="relative">
      <Button
        ref={triggerRef}
        type="button"
        variant="subtle"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={labels.label}
        aria-describedby={availability.text ? availabilityId : undefined}
        className="max-w-full px-2 aria-expanded:bg-fill-selected"
      >
        <StatusDot tone="neutral" className={identityDot} />
        <span className="truncate">{activeLabel}</span>
        {availability.cue ? (
          <AvailabilityGlyph cue={availability.cue} title={availability.text ?? undefined} />
        ) : null}
        {availability.text ? (
          <span id={availabilityId} className="sr-only">
            {availability.text}
          </span>
        ) : null}
        <ChevronDown size={ICON_MD} className="shrink-0 text-fg-muted" />
      </Button>

      {open ? (
        <div
          role="listbox"
          aria-label={labels.label}
          className="dropdown-panel app-scrollbar absolute top-full left-0 mt-1 max-h-[70vh] w-80 overflow-y-auto p-1"
        >
          <GroupHeading>{labels.mangostudioGroup}</GroupHeading>
          {isAgentListLoading ? (
            <p className="px-2 py-2 text-xs text-fg-muted">{labels.loading}</p>
          ) : null}
          {selectableAgents.map((agent) => {
            const active = runner.kind === 'mangostudio' && runner.agentId === agent.id;
            // `!active`, not a kind check: with turns on record, moving to any
            // other runner — another MangoStudio agent included — forks, while
            // re-picking the active one stays the no-op it always was.
            const forks = hasTurns && !active;
            return (
              <RunnerRow
                key={agent.id}
                name={agent.name}
                active={active}
                forkLabel={forks ? labels.continueInNewChat : null}
                onSelect={() => {
                  setOpen(false);
                  if (forks) {
                    onForkWithRunner({
                      kind: 'mangostudio',
                      agentId: agent.id as AgentProfile['id'],
                    });
                    return;
                  }
                  onSelectAgent(agent.id);
                }}
              />
            );
          })}

          <GroupHeading>{labels.externalGroup}</GroupHeading>
          {externalAgents.length === 0 ? (
            <p className="px-2 py-2 text-xs text-fg-muted">{labels.noneDiscovered}</p>
          ) : null}
          {externalAgents.map((descriptor) => (
            <ExternalRow
              key={descriptor.targetId}
              descriptor={descriptor}
              environmentName={environmentName}
              transportKind={environmentTransportKind}
              active={runner.kind === 'external' && runner.targetId === descriptor.targetId}
              // Same `!active` rule as the MangoStudio rows: a vendor swap
              // (codex → claude) is as much a runner change as a kind swap.
              forks={
                hasTurns && !(runner.kind === 'external' && runner.targetId === descriptor.targetId)
              }
              onSelect={(forking) => {
                setOpen(false);
                if (forking) {
                  onForkWithRunner({ kind: 'external', targetId: descriptor.targetId });
                  return;
                }
                onSelectExternal(descriptor);
              }}
            />
          ))}

          {/* Offered only where something can actually answer. A vendor with no
              listing gets its explanation inside the picker; an environment
              where *nothing* can list has no picker worth opening. */}
          {externalAgents.some((descriptor) => descriptor.capabilities.sessionListing) ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onBrowseSessions();
              }}
              className="flex min-h-8 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-fg transition-colors hover:bg-fill-hover"
            >
              <History size={ICON_MD} className="shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate">{t.externalAgents.sessions.entry}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const AVAILABILITY_GLYPH: Record<Exclude<AvailabilityCue, 'loading'>, ReactNode> = {
  neutral: <Info size={ICON_SM} className="text-fg-muted" />,
  warning: <TriangleAlert size={ICON_SM} className="text-warning" />,
  error: <CircleX size={ICON_SM} className="text-danger" />,
};

/**
 * Why the runner named beside it cannot take a turn, as a glyph in the status
 * colour — never the identity dot, which only says who the runner is. The words
 * are the trigger's description for a screen reader and the glyph's tooltip for
 * everyone else, so the colour is never the whole signal.
 */
function AvailabilityGlyph({ cue, title }: { cue: AvailabilityCue; title?: string }) {
  return (
    <span aria-hidden="true" data-availability={cue} title={title} className="flex shrink-0">
      {cue === 'loading' ? <Spinner size="sm" /> : AVAILABILITY_GLYPH[cue]}
    </span>
  );
}

function GroupHeading({ children }: { children: string }) {
  return (
    <MicroLabel as="p" className="px-2 pb-1 pt-2">
      {children}
    </MicroLabel>
  );
}

function RunnerRow({
  name,
  active,
  forkLabel,
  onSelect,
}: {
  name: string;
  active: boolean;
  forkLabel: string | null;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        'flex min-h-8 w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-fg transition-colors',
        active ? 'bg-fill-selected' : 'hover:bg-fill-hover'
      )}
    >
      {/* Who answers, in the colour the trigger, the sidebar and Home draw it.
          Every MangoStudio agent is MangoStudio running it, so they share one. */}
      <StatusDot tone="neutral" className={MANGO_IDENTITY.dotClass} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {forkLabel ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-fg-muted">
          <CornerUpRight size={ICON_SM} />
          {forkLabel}
        </span>
      ) : null}
      {active ? <Check size={ICON_MD} className="shrink-0 text-accent-fg" /> : null}
    </button>
  );
}

/**
 * Which fix an unproven machine needs, from how MangoStudio reaches it.
 *
 * The transport is a fair proxy because it *is* the thing that decides whose OS
 * account the vendor signs in as: an in-process or stdio runtime runs as the hub
 * user, ssh lands on whatever login the environment carries, a container has
 * whatever the image and its mounts give it. `http` falls to the generic advice
 * rather than to `paired` — a Direct URL machine was configured, not paired, and
 * telling its owner to "pair your own" would name a flow they never used.
 */
function isolationFixFor(
  transportKind: EnvironmentTransportKind | undefined
): keyof Messages['externalAgents']['isolation']['next'] {
  switch (transportKind) {
    case 'in-process':
    case 'stdio':
      return 'local';
    case 'wsl':
      return 'wsl';
    case 'ssh':
      return 'ssh';
    case 'container':
      return 'container';
    case 'websocket':
      return 'paired';
    default:
      return 'generic';
  }
}

/**
 * One external agent, in whatever state that machine reports.
 *
 * The eight availability states are not decorations. Each of them is a different
 * thing the user has to do — install it, sign in, update the runtime, ask the
 * machine's owner — and collapsing them into "unavailable" leaves someone
 * staring at a disabled row with nothing to try.
 */
function ExternalRow({
  descriptor,
  environmentName,
  transportKind,
  active,
  forks,
  onSelect,
}: {
  descriptor: ExternalAgentDescriptor;
  environmentName: string;
  transportKind?: EnvironmentTransportKind;
  active: boolean;
  forks: boolean;
  onSelect: (forking: boolean) => void;
}) {
  const { t } = useI18n();
  const labels = t.externalAgents;
  const nameId = useId();
  const forkId = useId();
  const statusId = useId();

  const reason = descriptor.unavailableReason;
  const signedOut = descriptor.installed && descriptor.authState === 'signed-out';
  const notInstalled = !descriptor.installed && !reason;
  const selectable = externalAgentSelectable(descriptor);

  const explanation = reason
    ? reason === 'not-installed'
      ? labels.selector.notInstalledIn.replace('{environment}', environmentName)
      : // `version-unsupported` is the one reason whose copy names a build, and
        // the build is the adapter's pin rather than anything this bundle knows.
        externalUnavailableText(reason, t, descriptor.requiredVersion)
    : signedOut
      ? labels.unavailable['signed-out']
      : notInstalled
        ? labels.selector.notInstalledIn.replace('{environment}', environmentName)
        : descriptor.discoveryState === 'undetermined'
          ? labels.selector.discoveryUndeterminedHint
          : null;
  // Who the agent is signed in as, or that nobody can tell. A line under the name
  // rather than a badge beside it: on the name's line it left the name, the only
  // part allowed to shrink, as "C…" in a 320px panel.
  const account =
    descriptor.authState === 'signed-in'
      ? (descriptor.account?.label ?? labels.selector.signedIn)
      : null;
  const authUnknown = selectable && descriptor.authState === 'unknown';
  const hasStatus = account !== null || authUnknown || explanation !== null;

  // The notice is the one refusal this menu clears itself: picking the row opens
  // it (the container routes a pick, and a fork, through the notice first). Its
  // way through stands where "Continue in a new chat" would, so the row offers
  // the step it will actually take rather than promising a chat it cannot open.
  const disclosureRequired = reason === 'disclosure-required';
  const forkHint = selectable && forks && !disclosureRequired;

  return (
    <div>
      {/* The actions beside the row centre on its name's 32px line, not on the
          whole block, so they stay level with the name when status lines follow. */}
      <div className="flex w-full items-start gap-1">
        <button
          type="button"
          role="option"
          aria-selected={active}
          aria-labelledby={forkHint ? `${nameId} ${forkId}` : nameId}
          aria-describedby={hasStatus ? statusId : undefined}
          disabled={!selectable}
          onClick={() => onSelect(forks)}
          className={cn(
            // A runner this machine cannot use is not faded: its name says which
            // agents exist, and the lines under it say why it is out of reach.
            // The name steps down a text colour instead.
            'flex min-h-8 min-w-0 flex-1 items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-fg transition-colors disabled:cursor-not-allowed disabled:text-fg-muted',
            active ? 'bg-fill-selected' : 'enabled:hover:bg-fill-hover'
          )}
        >
          {/* Who the runner is, in the hue the trigger, the sidebar and Home use.
              A background, so a disabled row keeps it at full strength: an
              agent's identity stays its colour while its name steps down. */}
          <StatusDot
            tone="neutral"
            className={cn('mt-1.5', agentIdentityTokens(descriptor.targetId).dotClass)}
          />
          {/* The name and what is true of it are one block, like a permission
              option's title and description: the status lines sit 2px under the
              name, so they read as this row's and not as the gap between two. */}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              {/* A vendor's product name is short and is the row's whole identity:
                  it never yields. The hint after it does, if anything has to. */}
              <span id={nameId} className="shrink-0">
                {labels.target[descriptor.targetId]}
              </span>
              {forkHint ? (
                <span
                  id={forkId}
                  className="ml-auto flex min-w-0 items-center gap-1 text-xs text-fg-muted"
                >
                  <CornerUpRight size={ICON_SM} aria-hidden="true" className="shrink-0" />
                  <span className="truncate">{labels.selector.continueInNewChat}</span>
                </span>
              ) : null}
              {active ? <Check size={ICON_MD} className="ml-auto shrink-0 text-accent-fg" /> : null}
            </span>
            {hasStatus ? (
              <span
                id={statusId}
                className="mt-0.5 block space-y-0.5 text-xs leading-4 text-fg-muted"
              >
                {account !== null ? (
                  // The status pattern: a glyph in the status colour with the
                  // words in the ordinary text colour.
                  <span className="flex min-w-0 items-center gap-1">
                    <Check size={ICON_SM} aria-hidden="true" className="shrink-0 text-success" />
                    <span className="truncate">{account}</span>
                  </span>
                ) : null}
                {authUnknown ? <span className="block">{labels.selector.authUnknown}</span> : null}
                {explanation && disclosureRequired ? (
                  // A runner that cannot answer until its notice is read is a
                  // thing to fix: the warning the trigger and Home show for it.
                  <span className="flex items-start gap-1">
                    <TriangleAlert
                      size={ICON_SM}
                      aria-hidden="true"
                      className="mt-px shrink-0 text-warning"
                    />
                    <span>{explanation}</span>
                  </span>
                ) : explanation ? (
                  <span className="block">{explanation}</span>
                ) : null}
              </span>
            ) : null}
          </span>
        </button>
        {descriptor.capabilities.accountUsage && selectable ? (
          <div className="flex h-8 shrink-0 items-center pr-2">
            <ExternalAccountLimitsChipFor descriptor={descriptor} />
          </div>
        ) : null}
        {/* The remedies MangoStudio can act on. Install and update link into the
            surface that already owns the recipes rather than growing a second
            install affordance here — `claude.install` and `claude.update` and
            their Codex and Cursor equivalents live there, keyed by the same
            target id. The notice is read through the row's own pick, so its
            button does what clicking the row does. Every other remedy either has
            its own control below (sign-in), its own panel (isolation), or
            nothing to offer. On the name's line, right-aligned, as "Continue in
            a new chat" is on a usable row: a runner that is not installed is a
            name, the reason under it, and the way out beside it. It takes no
            inset of its own: the small button's padding already ends its label
            8px from the edge, where the row button's padding ends the fork hint. */}
        {disclosureRequired && selectable ? (
          <div className="flex h-8 shrink-0 items-center">
            <Button type="button" variant="subtle" size="sm" onClick={() => onSelect(forks)}>
              {labels.remedy['accept-disclosure']}
            </Button>
          </div>
        ) : descriptor.remedy ? (
          <ExternalRemedyLink
            remedy={descriptor.remedy}
            className="flex h-8 shrink-0 items-center"
          />
        ) : null}
      </div>

      {/* The one refusal whose fix is an administrative change to a machine
          rather than a click. A one-line "this machine has not proven it keeps
          credentials separate" leaves the reader with nothing to do about it. */}
      {reason === 'isolation-unproven' ? (
        <Callout tone="neutral" title={labels.isolation.title} className="mx-2 mb-2">
          <p className="text-xs leading-relaxed">{labels.isolation.why}</p>
          <p className="pt-1 text-xs font-medium text-fg">{labels.isolation.nextStep}</p>
          <p className="text-xs leading-relaxed">
            {labels.isolation.next[isolationFixFor(transportKind)]}
          </p>
        </Callout>
      ) : null}

      {/* The vendor's own login command, with a copy button: the user has to run
          it on *that* machine, which MangoStudio cannot do for them. */}
      {signedOut && descriptor.loginCommand ? (
        <SignInCommand command={descriptor.loginCommand} className="mx-2 mb-2" />
      ) : null}
    </div>
  );
}

/** Loads cached quota and offers a manual refresh — never polls. */
function ExternalAccountLimitsChipFor({ descriptor }: { descriptor: ExternalAgentDescriptor }) {
  const { limits, refreshing, refresh } = useExternalAccountLimits(descriptor);
  return <ExternalAccountLimitsChip limits={limits} refreshing={refreshing} onRefresh={refresh} />;
}
