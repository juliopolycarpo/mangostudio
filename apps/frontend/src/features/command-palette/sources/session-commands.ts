/**
 * Sessions, newest first, from the chat list already in the query cache.
 *
 * The haystack is the sidebar's, not a second one: `chatSearchText` is what its
 * search box filters on, so a folder name that finds a session there finds it
 * here too.
 */

import type { Chat } from '@mangostudio/shared/chat';
import { MessageSquare } from 'lucide-react';
import type { CommandItem } from '@/features/command-palette/lib/command-item';
import { chatSearchText } from '@/features/sidebar/lib/filter-chats';
import { type RunnerBadgeLabels, runnerBadge } from '@/features/sidebar/lib/runner-badge';
import { formatRelativeTime } from '@/lib/i18n-format';
import { workdirBasename } from '@/lib/paths';

export interface SessionCommandParams {
  readonly chats: readonly Chat[];
  readonly badgeLabels: RunnerBadgeLabels;
  readonly locale: string;
  /** Passed in rather than read, so the relative times a test asserts are fixed. */
  readonly nowMs: number;
  readonly onSelect: (chatId: string) => void;
}

export function sessionCommands({
  chats,
  badgeLabels,
  locale,
  nowMs,
  onSelect,
}: SessionCommandParams): CommandItem[] {
  return [...chats]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((chat) => {
      const badge = runnerBadge(chat.runner, badgeLabels);
      return {
        id: `session:${chat.id}`,
        section: 'sessions' as const,
        label: chat.title,
        hint: workdirBasename(chat.workdir) ?? undefined,
        meta: formatRelativeTime(chat.updatedAt, locale, nowMs),
        keywords: chatSearchText(chat, () => badge.label),
        icon: MessageSquare,
        badge,
        run: () => onSelect(chat.id),
      };
    });
}
