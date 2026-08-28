/**
 * The slash commands an external agent session announced, cached per chat.
 *
 * Live-only, and deliberately so. There is no route behind this key: the hub
 * never persists a catalog, because it describes a process that no longer
 * exists once the session ends. A reload therefore starts empty and the
 * composer falls back to what the library scanned on disk until the next turn
 * announces the list again.
 *
 * Keyed by chat rather than by target, because two chats on the same vendor can
 * be bound to different sessions — and, for Cursor, to catalogs taken at
 * different moments.
 */

import type { ExternalAgentCommand } from '@mangostudio/shared/external-agents';
import type { QueryClient } from '@tanstack/react-query';

export const externalCommandKeys = {
  all: ['external-commands'] as const,
  byChat: (chatId: string) => ['external-commands', chatId] as const,
};

/**
 * Files the catalog a turn's stream carried.
 *
 * Last write wins, including an empty list: "this session has no commands" is
 * an answer, and keeping the previous one would leave the palette offering
 * commands from whatever session ran before this chat was re-bound.
 * // Usage: publishExternalCommands(queryClient, chatId, chunk.commands)
 */
export function publishExternalCommands(
  queryClient: QueryClient,
  chatId: string | null,
  commands: readonly ExternalAgentCommand[]
): void {
  if (!chatId) return;
  queryClient.setQueryData(externalCommandKeys.byChat(chatId), commands);
}
