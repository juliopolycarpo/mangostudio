/**
 * Every folder the account works in, as a grid — the cross-workspace answer to
 * the question the chat hub's `WorkspaceCard` answers for one session.
 *
 * The fork from that card is deliberate and is the whole reason this file
 * exists: `useGitState` is a `GET /git/state` per chat, and a grid of folders
 * asking it once per card is an N+1 the moment somebody has three repositories
 * open. This reads the batched summaries the sidebar already fetches, with one
 * representative chat per folder, so a 30-chat/3-repo account costs three ids
 * inside a request that was going out anyway.
 */

import type { Chat } from '@mangostudio/shared';
import { useQuery } from '@tanstack/react-query';
import { FolderGit2, GitBranch, MessageSquarePlus, Play } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { SectionCard } from '@/components/ui/SectionCard';
import { StatusDot } from '@/components/ui/StatusDot';
import { chatListQueryOptions } from '@/features/chat/queries';
import { runnerBadge } from '@/features/sidebar/lib/runner-badge';
import { useBatchedGitSummaries } from '@/features/workspace/hooks/use-git-state';
import { useI18n } from '@/hooks/use-i18n';
import { branchLabel } from '@/lib/git-branch';
import { formatMessage } from '@/lib/i18n-format';
import { groupChatsByWorkdir, type WorkspaceGroup } from '../lib/group-chats-by-workdir';
import { HubSkeletonLines } from './HubSkeletonLines';

const NO_CHATS: readonly Chat[] = [];

interface WorkspacesGridProps {
  /** Folders the picker remembers, so one chosen but never used still shows. */
  readonly recentWorkdirs: readonly string[];
  readonly onSelectChat: (chatId: string) => void;
  readonly onNewChatInWorkdir: (workdir: string) => void;
  /** The empty account's way in: no folders, no sessions, nothing to resume. */
  readonly onNewChat: () => void;
}

export function WorkspacesGrid({
  recentWorkdirs,
  onSelectChat,
  onNewChatInWorkdir,
  onNewChat,
}: WorkspacesGridProps) {
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
    <SectionCard label={labels.label} tone="accent">
      {isPending && groups.length === 0 ? <HubSkeletonLines /> : null}

      {!isPending && groups.length === 0 ? (
        <EmptyWorkspaces onNewChat={onNewChat} />
      ) : (
        <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {groups.map((group) => (
            <li key={group.workdir}>
              <WorkspaceTile
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
      )}

      {overflowCount > 0 ? (
        <p className="text-xs text-on-surface-variant/70">
          {formatMessage(labels.more, { count: String(overflowCount) })}
        </p>
      ) : null}
    </SectionCard>
  );
}

/**
 * Persona one: a brand new account with no chat and no remembered folder. The
 * grid is the surface that has something to say to them, so it says it here
 * rather than collapsing to nothing and leaving a labelled empty box.
 */
function EmptyWorkspaces({ onNewChat }: { onNewChat: () => void }) {
  const { t } = useI18n();
  const labels = t.home.workspaces;
  return (
    <div className="space-y-2.5">
      <p className="text-sm text-on-surface-variant">{labels.empty}</p>
      <Button variant="secondary" size="sm" onClick={onNewChat} className="gap-1.5">
        <MessageSquarePlus size={13} />
        {t.chat.newChat}
      </Button>
    </div>
  );
}

interface WorkspaceTileProps {
  readonly group: WorkspaceGroup;
  /** Absent while the batch is in flight; `null` when the server has no answer. */
  readonly summary: ReturnType<typeof useBatchedGitSummaries>[string] | undefined;
  readonly onSelectChat: (chatId: string) => void;
  readonly onNewChatInWorkdir: (workdir: string) => void;
}

function WorkspaceTile({ group, summary, onSelectChat, onNewChatInWorkdir }: WorkspaceTileProps) {
  const { t } = useI18n();
  const labels = t.home.workspaces;
  const badgeLabels = t.sidebar.runner;
  const branch = summary ? branchLabel(summary.branch, summary.detachedAt) : null;

  return (
    <article
      className="flex h-full min-w-0 flex-col gap-2 rounded-lg border border-outline-variant/15 bg-surface-container-low/60 p-3"
      data-testid="workspace-tile"
      data-workdir={group.workdir}
    >
      <p className="flex min-w-0 items-center gap-1.5">
        <FolderGit2 size={13} aria-hidden="true" className="shrink-0 text-on-surface-variant/60" />
        <span className="truncate font-mono text-sm text-on-surface" title={group.workdir}>
          {group.name}
        </span>
      </p>

      {summary === undefined && group.representativeChatId ? <HubSkeletonLines /> : null}

      {branch && summary ? (
        <div className="space-y-1 font-mono text-[11px]">
          <p className="flex min-w-0 items-center gap-1.5 text-on-surface-variant">
            <GitBranch size={11} aria-hidden="true" className="shrink-0" />
            <span className="truncate text-on-surface">{branch}</span>
          </p>
          <p className="text-on-surface-variant/80">
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

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-on-surface-variant/70">
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

      <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
        {group.representativeChatId ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onSelectChat(group.representativeChatId as string)}
            className="gap-1.5"
            aria-label={formatMessage(labels.continueSession, {
              title: group.representativeTitle ?? group.name,
            })}
          >
            <Play size={12} />
            {labels.continueLatest}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onNewChatInWorkdir(group.workdir)}
          className="gap-1.5"
          aria-label={formatMessage(labels.newChatHereIn, { folder: group.name })}
        >
          <MessageSquarePlus size={12} />
          {labels.newChatHere}
        </Button>
      </div>
    </article>
  );
}
