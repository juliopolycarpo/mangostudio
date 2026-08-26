import type { GithubIssueSummary } from '@mangostudio/shared/github';
import { MessageSquarePlus } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { MenuItem } from '@/components/ui/Menu';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { GithubRowMenu } from './GithubRowMenu';

interface GithubIssueRowProps {
  readonly chatId: string;
  readonly nameWithOwner: string;
  readonly issue: GithubIssueSummary;
  readonly onStartChat: (issue: GithubIssueSummary) => void;
}

/**
 * One issue in the repository list.
 *
 * Its primary action is "start a chat from this", not "read this" — an issue is
 * a piece of work waiting for somebody, and the panel's job is to be the
 * shortest path from noticing it to an agent working on it.
 *
 * @example
 * <GithubIssueRow chatId={chatId} nameWithOwner="mango/studio" issue={issue} onStartChat={start} />
 */
export function GithubIssueRow({ chatId, nameWithOwner, issue, onStartChat }: GithubIssueRowProps) {
  const { t } = useI18n();

  return (
    <li className="group flex items-start gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-surface-container-high/50">
      <button
        type="button"
        onClick={() => onStartChat(issue)}
        title={t.github.actions.issueToNewChat}
        className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-mono text-[10px] text-on-surface-variant">
            {formatMessage(t.github.row.number, { number: String(issue.number) })}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-on-surface">
            {issue.title}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[10px] text-on-surface-variant">
          {issue.assignees.length > 0
            ? formatMessage(t.github.row.assignees, {
                assignees: issue.assignees.map((actor) => actor.login).join(', '),
              })
            : t.github.row.unassigned}
        </span>
      </button>
      <Badge
        variant={issue.state === 'OPEN' ? 'success' : 'neutral'}
        className="px-1.5 py-0.5 text-[9px] tracking-normal"
      >
        {t.github.issueState[issue.state]}
      </Badge>
      <GithubRowMenu
        chatId={chatId}
        target={{ url: issue.url, number: issue.number, nameWithOwner }}
      >
        <MenuItem onSelect={() => onStartChat(issue)} icon={<MessageSquarePlus size={13} />}>
          {t.github.actions.issueToNewChat}
        </MenuItem>
      </GithubRowMenu>
    </li>
  );
}
