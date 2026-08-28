/**
 * What the composer's `/` palette can offer this chat.
 *
 * Three sources, layered in order of how much they know:
 *
 * 1. **The session's own catalog**, announced by the vendor mid-turn. The only
 *    source that knows about plugin commands and the skills a build ships, and
 *    the only one that describes the process actually running.
 * 2. **The library scan**, for external chats that have not run a turn yet.
 *    Commands only: whether a *skill* is reachable as `/name` is a per-vendor
 *    fact the vendor's own catalog already answers, and guessing it from a
 *    directory listing would offer names the CLI never registers.
 * 3. **The user's skills**, for MangoStudio's own runner, which has no commands
 *    of its own (issue #961). Filtered and capped the way
 *    `buildSkillsPromptSection` filters and caps, so the palette offers what the
 *    turn will advertise. Read user-scoped rather than through the chat's
 *    capabilities because the composer on the home screen has no chat behind it
 *    yet, and `/` has to work on the first message rather than the second.
 *    Narrowed by the chat's own capabilities once there is a chat to ask about:
 *    that projection is resolved by the same code generation uses, and it is the
 *    only thing that knows whether the tool profile admits the `skill` tool at
 *    all — without it a chat with skills turned off is offered `/dataviz` and
 *    sends it to a model with no `<available-skills>` section to read it by.
 */

import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { ExternalAgentCommand } from '@mangostudio/shared/external-agents';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { externalCommandKeys } from '@/features/external-agents/command-catalog';
import { libraryResourcesQueryOptions } from '@/features/library/queries';
import { skillSettingsListQueryOptions } from '@/features/settings/skills/queries';
import { mergeSlashCommands, type SlashCommandEntry } from '../lib/slash-commands';
import { chatCapabilitiesQueryOptions } from './use-chat-capabilities';

/** Shared so an unannounced catalog is referentially stable across renders. */
const NO_COMMANDS: readonly ExternalAgentCommand[] = [];

/** How long an idle chat keeps the catalog its last session announced. */
const SESSION_CATALOG_GC_MS = 60 * 60 * 1_000;

/**
 * The ceiling `buildSkillsPromptSection` advertises, mirrored so the palette
 * cannot offer the 65th name alphabetically — the turn would not list it.
 */
const MAX_LISTED_SKILLS = 64;

interface Options {
  readonly chatId: string | null;
  readonly runner: ChatRunnerConfiguration | undefined;
  readonly environmentId: string | null;
  /**
   * The composer's pending model and agent, passed through to the capability
   * projection so it answers for the turn this palette is about to start rather
   * than for the chat's saved selection.
   */
  readonly activeModel?: string | null | undefined;
  readonly selectedAgentId?: string | undefined;
  /**
   * Whether the palette is open.
   *
   * The fallback sources are not free — a library scan walks directories on
   * whichever machine the chat runs on — and a composer that paid for them on
   * mount would charge every chat for a menu most turns never open. The
   * session catalog is exempt: it is a cache read with no request behind it.
   */
  readonly active: boolean;
}

export interface SlashCommandSources {
  readonly entries: readonly SlashCommandEntry[];
  /**
   * Whether a fallback source is still answering.
   *
   * Reported rather than folded into an empty list because the two are
   * different answers: "this chat has no `/review`" is worth saying, and
   * "the scan has not come back yet" is a claim the palette has no business
   * making while a directory walk on the runtime host is still in flight.
   */
  readonly loading: boolean;
}

/**
 * The palette's entries for one chat, already merged and de-duplicated.
 * // Usage: const { entries, loading } = useSlashCommands({ chatId, runner, environmentId, active: true });
 */
export function useSlashCommands({
  chatId,
  runner,
  environmentId,
  activeModel,
  selectedAgentId,
  active,
}: Options): SlashCommandSources {
  const targetId = runner?.kind === 'external' ? runner.targetId : null;

  // A subscription, not a fetch: nothing serves this key, and the stream's
  // `external_commands` chunk is its only writer. Subscribing through the query
  // client rather than reading the cache once is what re-renders the palette
  // when a turn announces a catalog while the menu is open.
  //
  // `enabled: false` is load-bearing. A placeholder fetch would resolve *after*
  // a catalog published in the same tick and overwrite it with the empty list
  // — which is exactly what a chat opened mid-turn does.
  const sessionQuery = useQuery({
    queryKey: externalCommandKeys.byChat(chatId ?? ''),
    queryFn: (): readonly ExternalAgentCommand[] => NO_COMMANDS,
    enabled: false,
    initialData: NO_COMMANDS,
    staleTime: Number.POSITIVE_INFINITY,
    // Bounded rather than infinite: `initialData` seeds an entry for every chat
    // the composer ever mounts against — native runners included, where nothing
    // writes this key — and React Query keeps the largest `gcTime` any observer
    // declared, so an infinite one is a per-chat leak for the life of the tab.
    // An hour outlives any plausible navigate-away-and-back.
    gcTime: SESSION_CATALOG_GC_MS,
  });

  const libraryQuery = useQuery({
    ...libraryResourcesQueryOptions('command', environmentId ?? undefined),
    enabled: active && targetId !== null,
  });

  const skillsQuery = useQuery({
    ...skillSettingsListQueryOptions(),
    enabled: active && targetId === null,
  });

  // The same selection `CapabilityInspector` builds, so the two share one cache
  // entry: a user who has opened the inspector has already paid for this.
  const capabilitiesQuery = useQuery({
    ...chatCapabilitiesQueryOptions({
      chatId: chatId ?? '',
      ...(activeModel ? { model: activeModel } : {}),
      ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
    }),
    enabled: active && targetId === null && chatId !== null,
  });

  const session = sessionQuery.data;
  const library = libraryQuery.data;
  const skills = skillsQuery.data;

  /**
   * Skill keys this chat's next turn will advertise, or `undefined` when the
   * projection has not answered.
   *
   * `state === 'enabled'` is the whole of `buildSkillsPromptSection`'s filter
   * plus the `skill`-tool check `appendSkillsPromptSection` makes, resolved by
   * the server rather than mirrored here. Undefined is deliberately distinct
   * from empty: an unasked or failed projection must not empty a palette the
   * user-scoped filter can still answer for.
   */
  const advertisedKeys = useMemo(() => {
    const entries = capabilitiesQuery.data?.skills;
    if (!entries) return undefined;
    return new Set(entries.filter((skill) => skill.state === 'enabled').map((skill) => skill.key));
  }, [capabilitiesQuery.data]);

  const entries = useMemo(() => {
    // Gated on the runner like the other two sources. The catalog outlives the
    // session that announced it — nothing invalidates the key — so a chat moved
    // off its vendor onto MangoStudio's own runner would otherwise still be
    // offered the vendor's names, which reach a native turn as ordinary prose.
    const sessionEntries: SlashCommandEntry[] =
      targetId === null
        ? []
        : (session ?? []).map((command) => ({
            name: command.name,
            ...(command.description ? { description: command.description } : {}),
            origin: 'session' as const,
          }));

    // Anything but `absent`: `shadowed` means this target *does* read a copy,
    // from `effectiveLocationId`, and merely has others behind it — the same
    // predicate `presentTargetCount` in `features/library/format.ts` uses.
    const libraryEntries: SlashCommandEntry[] =
      targetId === null
        ? []
        : (library?.resources ?? [])
            .filter((resource) =>
              resource.coverage.some(
                (coverage) => coverage.targetId === targetId && coverage.state !== 'absent'
              )
            )
            .map((resource) => ({ name: resource.ref.slug, origin: 'library' as const }));

    // The same three flags and the same ceiling `buildSkillsPromptSection`
    // applies, so the palette cannot offer a name the turn will not advertise:
    // a shadowed slug resolves to a different source's copy, an invalid one to
    // nothing, and the 65th name alphabetically is cut from the section. When
    // the chat's projection has answered it narrows this further, since only it
    // knows whether the `skill` tool survives the chat's tool profile.
    //
    // Home screen aside: with no chat there is no profile to ask about, so the
    // palette offers what the user has installed and the first turn decides.
    // `advertisedKeys === undefined` alone would also cover a projection still
    // in flight, and falling back to unfiltered there too would let the
    // palette advertise a skill this turn's tool profile ends up excluding —
    // offering `/name` a beat before `appendSkillsPromptSection` would agree
    // to write its prompt section. `isLoading` is what tells "in flight" apart
    // from "unasked" and "failed", both of which still fail open below.
    const skillEntries: SlashCommandEntry[] =
      targetId !== null || capabilitiesQuery.isLoading
        ? []
        : (skills?.skills ?? [])
            .filter((skill) => skill.valid && skill.enabled && !skill.shadowed)
            .filter((skill) => advertisedKeys?.has(skill.key) ?? true)
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, MAX_LISTED_SKILLS)
            .map((skill) => ({
              name: skill.slug,
              ...(skill.description ? { description: skill.description } : {}),
              origin: 'skill' as const,
            }));

    return mergeSlashCommands(sessionEntries, libraryEntries, skillEntries);
  }, [session, library, skills, targetId, advertisedKeys, capabilitiesQuery.isLoading]);

  // Only the source this runner actually reads can hold the palette back, and
  // only while it is fetching: a *disabled* query reports `isPending` forever,
  // so the other one would keep the menu silent for good. The capability
  // projection joins the skill side for the same reason it withholds entries
  // above — `isLoading` is `false` while it is disabled, so the home-screen
  // case is unaffected.
  const loading =
    targetId === null
      ? skillsQuery.isLoading || capabilitiesQuery.isLoading
      : libraryQuery.isLoading;

  return { entries, loading };
}
