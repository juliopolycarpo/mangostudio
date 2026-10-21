/**
 * Work left behind in other chats: dirty trees and unpushed commits, across
 * every session that points at a folder.
 *
 * The whole card rides on the batched summaries the sidebar already fetches —
 * same query key, same chunks — so it adds no request. Hidden entirely when
 * everything else is committed and pushed, which is most days.
 */

import type { Chat } from '@mangostudio/shared/chat';
import { useQuery } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { useMemo } from 'react';
import { SectionCard } from '@/components/ui/SectionCard';
import { chatListQueryOptions } from '@/features/chat/queries';
import { useBatchedGitSummaries } from '@/features/workspace/hooks/use-git-state';
import { useI18n } from '@/hooks/use-i18n';
import { usePlural } from '@/hooks/use-plural';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';
import { uncommittedWork } from '../lib/uncommitted-work';

const NO_CHATS: readonly Chat[] = [];

interface UncommittedWorkCardProps {
  /** Excluded from the list: this chat's own state is already on screen. */
  currentChatId: string | null;
  onSelectChat: (chatId: string) => void;
}

export function UncommittedWorkCard({ currentChatId, onSelectChat }: UncommittedWorkCardProps) {
  const { t } = useI18n();
  const plural = usePlural();
  const labels = t.home.uncommitted;
  // One shared empty array, not a fresh `?? []`: an unsettled query would
  // otherwise hand every render a new identity and defeat the memo below.
  const chats: readonly Chat[] = useQuery(chatListQueryOptions()).data ?? NO_CHATS;
  // Memoized for the same reason the layout's caller is: this list feeds a
  // `useQueries` whose chunking keys on the array's identity.
  const gitChatIds = useMemo(
    () => chats.filter((chat) => chat.workdir).map((chat) => chat.id),
    [chats]
  );
  const summaries = useBatchedGitSummaries(gitChatIds);
  // Walks every chat in the account, so it is not something to redo on a
  // render that changed neither the sessions nor their git state.
  const work = useMemo(
    () => uncommittedWork(chats, summaries, currentChatId),
    [chats, summaries, currentChatId]
  );

  if (work.rows.length === 0) return null;

  return (
    <SectionCard label={labels.label} tone="warning" className="sm:col-span-2">
      <ul className="-mx-2 space-y-0.5">
        {work.rows.map((row) => (
          <li key={row.chatId}>
            <button
              type="button"
              onClick={() => onSelectChat(row.chatId)}
              aria-label={formatMessage(labels.open, { title: row.title })}
              className="flex min-h-10 w-full min-w-0 cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1 text-left transition-colors hover:bg-fill-hover"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg">{row.title}</span>
                {row.branch ? (
                  <span className="flex min-w-0 items-center gap-1 font-mono text-micro text-fg-subtle">
                    <GitBranch size={ICON_SM} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">{row.branch}</span>
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 space-x-2 font-mono text-micro text-warning">
                {row.changedFileCount > 0 ? (
                  <span>
                    {plural(
                      { one: labels.changedOne, other: labels.changedOther },
                      row.changedFileCount
                    )}
                  </span>
                ) : null}
                {row.ahead > 0 ? (
                  <span>
                    {plural({ one: labels.unpushedOne, other: labels.unpushedOther }, row.ahead)}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {work.overflowCount > 0 ? (
        <p className="text-xs text-fg-muted">
          {plural({ one: labels.moreOne, other: labels.moreOther }, work.overflowCount)}
        </p>
      ) : null}
    </SectionCard>
  );
}
