/**
 * Work left behind in other chats: dirty trees and unpushed commits, across
 * every session that points at a folder.
 *
 * The whole card rides on the batched summaries the sidebar already fetches —
 * same query key, same chunks — so it adds no request. Hidden entirely when
 * everything else is committed and pushed, which is most days.
 */

import type { Chat } from '@mangostudio/shared';
import { useQuery } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { useMemo } from 'react';
import { SectionCard } from '@/components/ui/SectionCard';
import { chatListQueryOptions } from '@/features/chat/queries';
import { useBatchedGitSummaries } from '@/features/workspace/hooks/use-git-state';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { uncommittedWork } from '../lib/uncommitted-work';

const NO_CHATS: readonly Chat[] = [];

interface UncommittedWorkCardProps {
  /** Excluded from the list: this chat's own state is already on screen. */
  currentChatId: string | null;
  onSelectChat: (chatId: string) => void;
}

export function UncommittedWorkCard({ currentChatId, onSelectChat }: UncommittedWorkCardProps) {
  const { t } = useI18n();
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
      <ul className="divide-y divide-outline-variant/10">
        {work.rows.map((row) => (
          <li key={row.chatId}>
            <button
              type="button"
              onClick={() => onSelectChat(row.chatId)}
              aria-label={formatMessage(labels.open, { title: row.title })}
              className="flex w-full min-w-0 items-center justify-between gap-3 py-2 text-left transition-colors hover:text-on-surface"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-on-surface">{row.title}</span>
                {row.branch ? (
                  <span className="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[11px] text-on-surface-variant/70">
                    <GitBranch size={10} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">{row.branch}</span>
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 space-x-2 font-mono text-[11px] text-warning">
                {row.changedFileCount > 0 ? (
                  <span>
                    {formatMessage(labels.changed, { count: String(row.changedFileCount) })}
                  </span>
                ) : null}
                {row.ahead > 0 ? (
                  <span>{formatMessage(labels.unpushed, { count: String(row.ahead) })}</span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {work.overflowCount > 0 ? (
        <p className="text-xs text-on-surface-variant/70">
          {formatMessage(labels.more, { count: String(work.overflowCount) })}
        </p>
      ) : null}
    </SectionCard>
  );
}
