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
 * 3. **The chat's capabilities**, for MangoStudio's own runner, which has no
 *    commands of its own (issue #961) but does resolve an effective skill set
 *    server-side — the same one the turn will advertise to the model.
 */

import type { ChatRunnerConfiguration } from '@mangostudio/shared/chat';
import type { ExternalAgentCommand } from '@mangostudio/shared/external-agents';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { externalCommandKeys } from '@/features/external-agents/command-catalog';
import { libraryResourcesQueryOptions } from '@/features/library/queries';
import { mergeSlashCommands, type SlashCommandEntry } from '../lib/slash-commands';
import { chatCapabilitiesQueryOptions } from './use-chat-capabilities';

/** Shared so an unannounced catalog is referentially stable across renders. */
const NO_COMMANDS: readonly ExternalAgentCommand[] = [];

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

/**
 * The palette's entries for one chat, already merged and de-duplicated.
 * // Usage: const commands = useSlashCommands({ chatId, runner, environmentId });
 */
export function useSlashCommands({
  chatId,
  runner,
  environmentId,
  active,
}: Options): readonly SlashCommandEntry[] {
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
    gcTime: Number.POSITIVE_INFINITY,
  });

  const libraryQuery = useQuery({
    ...libraryResourcesQueryOptions('command', environmentId ?? undefined),
    enabled: active && targetId !== null,
  });

  const capabilitiesQuery = useQuery({
    ...chatCapabilitiesQueryOptions({ chatId: chatId ?? '' }),
    enabled: active && Boolean(chatId) && targetId === null,
  });

  const session = sessionQuery.data;
  const library = libraryQuery.data;
  const capabilities = capabilitiesQuery.data;

  return useMemo(() => {
    const sessionEntries: SlashCommandEntry[] = (session ?? []).map((command) => ({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      origin: 'session',
    }));

    // `present` and nothing else: a `shadowed` copy is a file this target will
    // never read, and offering it would put a name in the palette that the
    // agent answers with a different command's contents.
    const libraryEntries: SlashCommandEntry[] =
      targetId === null
        ? []
        : (library?.resources ?? [])
            .filter((resource) =>
              resource.coverage.some(
                (coverage) => coverage.targetId === targetId && coverage.state === 'present'
              )
            )
            .map((resource) => ({ name: resource.ref.slug, origin: 'library' as const }));

    const skillEntries: SlashCommandEntry[] =
      targetId !== null
        ? []
        : (capabilities?.skills ?? [])
            .filter((skill) => skill.state === 'enabled')
            .map((skill) => ({ name: skill.slug, origin: 'skill' as const }));

    return mergeSlashCommands(sessionEntries, libraryEntries, skillEntries);
  }, [session, library, capabilities, targetId]);
}
