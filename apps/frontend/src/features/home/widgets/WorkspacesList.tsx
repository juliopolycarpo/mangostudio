/**
 * Every folder the account works in, as a list — the cross-workspace answer to
 * the question the chat hub's `WorkspaceCard` answers for one session.
 *
 * The fork from that card is deliberate and is the whole reason this file
 * exists: `useGitState` is a `GET /git/state` per chat, and a grid of folders
 * asking it once per card is an N+1 the moment somebody has three repositories
 * open. This reads the batched summaries the sidebar already fetches, with one
 * representative chat per folder, so a 30-chat/3-repo account costs three ids
 * inside a request that was going out anyway.
 */

import type { Chat } from '@mangostudio/shared/chat';
import { useQuery } from '@tanstack/react-query';
import { FolderGit2, GitBranch, MessageSquarePlus, Play } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatusDot } from '@/components/ui/StatusDot';
import { chatListQueryOptions } from '@/features/chat/queries';
import { runnerBadge } from '@/features/sidebar/lib/runner-badge';
import { useBatchedGitSummaries } from '@/features/workspace/hooks/use-git-state';
import { useI18n } from '@/hooks/use-i18n';
import { branchLabel } from '@/lib/git-branch';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_LG, ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { groupChatsByWorkdir, type WorkspaceGroup } from '../lib/group-chats-by-workdir';
import { HubSkeletonLines } from './HubSkeletonLines';

const NO_CHATS: readonly Chat[] = [];

interface WorkspacesListProps {
  /** Folders the picker remembers, so one chosen but never used still shows. */
  readonly recentWorkdirs: readonly string[];
  readonly onSelectChat: (chatId: string) => void;
  readonly onNewChatInWorkdir: (workdir: string, environmentId: string) => void;
  /** The empty account's way in: no folders, no sessions, nothing to resume. */
  readonly onNewChat: () => void;
}

export function WorkspacesList({
  recentWorkdirs,
  onSelectChat,
  onNewChatInWorkdir,
  onNewChat,
}: WorkspacesListProps) {
  const { t } = useI18n();
  const labels = t.home.workspaces;
  // One shared empty array, not a fresh `?? []`: an unsettled query would
  // otherwise hand every render a new identity and defeat the memo below.
  const { data, isPending } = useQuery(chatListQueryOptions());
  const chats: readonly Chat[] = data ?? NO_CHATS;
  // Walks every chat in the account, so it is not something to redo on a
  // render that changed neither the sessions nor the remembered folders.
  const { groups, overflowCount } = useMemo(
    () => groupChatsByWorkdir(chats, recentWorkdirs),
    [chats, recentWorkdirs]
  );
  // Every chat with a folder, not just the representatives — the same list the
  // shell and the uncommitted-work card pass. The chunk key is the sorted ids,
  // so asking for the subset would miss their cache entry and cost a *second*
  // batched request to learn strictly less. Only the representatives are read
  // out of the answer.
  const gitChatIds = useMemo(
    () => chats.filter((chat) => chat.workdir).map((chat) => chat.id),
    [chats]
  );
  const summaries = useBatchedGitSummaries(gitChatIds);

  return (
    <SectionCard label={labels.label} tone="neutral">
      {isPending && groups.length === 0 ? <HubSkeletonLines /> : null}

      {!isPending && groups.length === 0 ? <EmptyWorkspaces onNewChat={onNewChat} /> : null}

      {groups.length > 0 ? (
        <ul className="divide-y divide-stroke">
          {groups.map((group) => (
            <li key={group.key} className="py-3 first:pt-0 last:pb-0">
              <WorkspaceRow
                group={group}
                summary={
                  group.representativeChatId ? summaries[group.representativeChatId] : undefined
                }
                onSelectChat={onSelectChat}
                onNewChatInWorkdir={onNewChatInWorkdir}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {overflowCount > 0 ? (
        <p className="text-xs text-fg-muted">
          {formatMessage(labels.more, { count: String(overflowCount) })}
        </p>
      ) : null}
    </SectionCard>
  );
}

/**
 * Persona one: a brand new account with no chat and no remembered folder. The
 * list is the surface that has something to say to them, so it says it here
 * rather than collapsing to nothing and leaving a labelled empty box.
 */
function EmptyWorkspaces({ onNewChat }: { onNewChat: () => void }) {
  const { t } = useI18n();
  const labels = t.home.workspaces;
  return (
    <EmptyState
      icon={<FolderGit2 size={ICON_LG} />}
      title={labels.empty}
      action={
        <Button variant="secondary" size="sm" onClick={onNewChat}>
          <MessageSquarePlus size={ICON_SM} />
          {t.chat.newChat}
        </Button>
      }
    />
  );
}

interface WorkspaceRowProps {
  readonly group: WorkspaceGroup;
  /** Absent while the batch is in flight; `null` when the server has no answer. */
  readonly summary: ReturnType<typeof useBatchedGitSummaries>[string] | undefined;
  readonly onSelectChat: (chatId: string) => void;
  readonly onNewChatInWorkdir: (workdir: string, environmentId: string) => void;
}

function WorkspaceRow({ group, summary, onSelectChat, onNewChatInWorkdir }: WorkspaceRowProps) {
  const { t } = useI18n();
  const labels = t.home.workspaces;
  const badgeLabels = t.sidebar.runner;
  const branch = summary ? branchLabel(summary.branch, summary.detachedAt) : null;

  return (
    <article
      className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid="workspace-tile"
      data-workdir={group.workdir}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex min-w-0 items-center gap-2">
          <FolderGit2 size={ICON_MD} aria-hidden="true" className="shrink-0 text-fg-muted" />
          <span className="truncate font-mono text-sm text-fg" title={group.workdir}>
            {group.name}
          </span>
        </p>

        {/* Indented to the folder name (icon + gap), so the facts about the
            folder line up under it instead of under its icon. */}
        <div className="space-y-1 pl-6">
          {summary === undefined && group.representativeChatId ? <HubSkeletonLines /> : null}

          {branch && summary ? (
            <div className="space-y-1 font-mono text-xs">
              <p className="flex min-w-0 items-center gap-1.5 text-fg-muted">
                <GitBranch size={ICON_SM} aria-hidden="true" className="shrink-0" />
                <span className="truncate text-fg">{branch}</span>
              </p>
              <p className="text-fg-muted">
                <span
                  className={summary.changedFileCount > 0 ? 'text-warning' : 'text-success'}
                  data-testid="workspace-tile-tree"
                >
                  {summary.changedFileCount > 0
                    ? formatMessage(labels.dirty, { count: String(summary.changedFileCount) })
                    : labels.clean}
                </span>
                {summary.ahead > 0 || summary.behind > 0 ? (
                  <>
                    {' · '}
                    {formatMessage(t.sidebar.git.sync, {
                      ahead: String(summary.ahead),
                      behind: String(summary.behind),
                    })}
                  </>
                ) : null}
              </p>
            </div>
          ) : null}

          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
            <span>
              {group.sessionCount === 0
                ? labels.noSessions
                : formatMessage(labels.sessions, { count: String(group.sessionCount) })}
            </span>
            {group.runners.map((runner) => {
              const badge = runnerBadge(runner, badgeLabels);
              return (
                <span key={badge.label} className="flex items-center gap-1 font-mono">
                  <StatusDot tone="neutral" className={badge.dotClassName} />
                  {badge.label}
                </span>
              );
            })}
          </p>
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap gap-2">
        {group.representativeChatId ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onSelectChat(group.representativeChatId as string)}
            aria-label={formatMessage(labels.continueSession, {
              title: group.representativeTitle ?? group.name,
            })}
          >
            <Play size={ICON_SM} />
            {labels.continueLatest}
          </Button>
        ) : null}
        <Button
          variant="subtle"
          size="sm"
          onClick={() => onNewChatInWorkdir(group.workdir, group.environmentId)}
          aria-label={formatMessage(labels.newChatHereIn, { folder: group.name })}
        >
          <MessageSquarePlus size={ICON_SM} />
          {labels.newChatHere}
        </Button>
      </div>
    </article>
  );
}
