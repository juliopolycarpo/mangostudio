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
 *    yet, and `/` has to work on the first message rather than the second — the
 *    cost of that is one thing this cannot mirror, `appendSkillsPromptSection`'s
 *    check that the chat's tool profile allows the `skill` tool at all.
 */

import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { ExternalAgentCommand } from '@mangostudio/shared/external-agents';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { externalCommandKeys } from '@/features/external-agents/command-catalog';
import { libraryResourcesQueryOptions } from '@/features/library/queries';
import { skillSettingsListQueryOptions } from '@/features/settings/skills/queries';
import { mergeSlashCommands, type SlashCommandEntry } from '../lib/slash-commands';

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

  const session = sessionQuery.data;
  const library = libraryQuery.data;
  const skills = skillsQuery.data;

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
    // nothing, and the 65th name alphabetically is cut from the section.
    //
    // Known gap: that section is only appended when the chat's tool profile
    // allows the `skill` tool, which this hook cannot see from the home screen.
    const skillEntries: SlashCommandEntry[] =
      targetId !== null
        ? []
        : (skills?.skills ?? [])
            .filter((skill) => skill.valid && skill.enabled && !skill.shadowed)
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, MAX_LISTED_SKILLS)
            .map((skill) => ({
              name: skill.slug,
              ...(skill.description ? { description: skill.description } : {}),
              origin: 'skill' as const,
            }));

    return mergeSlashCommands(sessionEntries, libraryEntries, skillEntries);
  }, [session, library, skills, targetId]);

  // Only the source this runner actually reads can hold the palette back, and
  // only while it is fetching: a *disabled* query reports `isPending` forever,
  // so the other one would keep the menu silent for good.
  const loading = targetId === null ? skillsQuery.isLoading : libraryQuery.isLoading;

  return { entries, loading };
}
