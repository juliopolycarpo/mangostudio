import { useQuery } from '@tanstack/react-query';
import { Inbox, RefreshCw } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_LG } from '@/lib/icon-sizes';
import { githubInboxQueryOptions } from '../queries';
import { GithubNotConnected } from './GithubNotConnected';
import { GithubPrBadge } from './GithubPrBadge';
import { GithubRowMenu } from './GithubRowMenu';
import { GithubSection } from './GithubSection';
import { GithubRefreshButton, GithubStaleness } from './GithubStaleness';

interface GithubInboxSectionProps {
  readonly chatId: string;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}

/** The rail's testid for the cross-repo review queue. */
const GITHUB_INBOX_TESTID = 'github-inbox-section';

/**
 * Pull requests waiting on this user's review, across every repository.
 *
 * Sits above the repository section because it is the one thing on the panel
 * that is about the user rather than about the folder they happen to have open:
 * a review request does not stop mattering because you switched projects.
 *
 * @example
 * <GithubInboxSection chatId={chatId} collapsed={false} onToggle={toggleInbox} />
 */
export function GithubInboxSection({ chatId, collapsed, onToggle }: GithubInboxSectionProps) {
  const { t } = useI18n();
  const query = useQuery(githubInboxQueryOptions());
  const data = query.data;

  return (
    <GithubSection
      label={t.github.panel.inbox}
      testId={GITHUB_INBOX_TESTID}
      collapsed={collapsed}
      onToggle={onToggle}
      action={
        <>
          <GithubStaleness
            cachedAt={data?.state === 'ok' ? data.cachedAt : null}
            refreshing={query.isFetching}
          />
          <GithubRefreshButton
            onRefresh={() => void query.refetch()}
            refreshing={query.isFetching}
          />
        </>
      }
    >
      <InboxBody chatId={chatId} />
    </GithubSection>
  );
}

/**
 * Split from the section shell so the query's four-way degradation is one
 * function with early returns instead of a chain of ternaries in JSX.
 */
function InboxBody({ chatId }: { readonly chatId: string }) {
  const { t } = useI18n();
  const query = useQuery(githubInboxQueryOptions());

  if (query.isPending) {
    return (
      <EmptyState
        icon={<RefreshCw size={ICON_LG} className="animate-spin" />}
        title={t.github.loading}
        className="min-h-24 py-4"
      />
    );
  }
  if (query.isError || !query.data) {
    return <EmptyState title={t.github.errors.inbox} tone="error" className="min-h-24 py-4" />;
  }
  if (query.data.state !== 'ok') return <GithubNotConnected state={query.data.state} />;
  if (query.data.items.length === 0) {
    return (
      <EmptyState
        icon={<Inbox size={ICON_LG} />}
        title={t.github.empty.inbox}
        className="min-h-24 py-4"
      />
    );
  }

  return (
    <ul className="space-y-0.5">
      {query.data.items.map((item) => (
        <li
          key={item.url}
          className="group flex items-start gap-2 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-surface-container-high/50"
        >
          {/* An anchor, not a button: an inbox row is in another repository,
              so there is no local detail view to open — the browser is the
              destination and middle-click should behave like one. */}
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span className="block truncate text-xs font-semibold text-on-surface">
              {item.title}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[10px] text-on-surface-variant">
              {formatMessage(t.home.github.row, {
                repo: item.repository.nameWithOwner,
                number: String(item.number),
              })}
            </span>
          </a>
          <GithubPrBadge state={item.state} draft={item.isDraft} />
          <GithubRowMenu
            chatId={chatId}
            target={{
              url: item.url,
              number: item.number,
              nameWithOwner: item.repository.nameWithOwner,
            }}
          />
        </li>
      ))}
    </ul>
  );
}
