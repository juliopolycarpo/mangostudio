import { Inbox } from 'lucide-react';

import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_LG } from '@/lib/icon-sizes';

import type { GithubInbox } from '../hooks/use-github-inbox';
import { GithubNotConnected } from './GithubNotConnected';
import { GithubPrBadge } from './GithubPrBadge';
import { GithubRowMenu } from './GithubRowMenu';
import { GithubRowShell } from './GithubRowShell';
import { GithubSection } from './GithubSection';
import { GithubRefreshButton, GithubStaleness } from './GithubStaleness';

interface GithubInboxSectionProps {
  readonly chatId: string;
  /** The panel's read of the queue; the panel owns it to tell a signed-out `gh` from an empty queue. */
  readonly inbox: GithubInbox;
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
 * <GithubInboxSection chatId={chatId} inbox={inbox} collapsed={false} onToggle={toggleInbox} />
 */
export function GithubInboxSection({
  chatId,
  inbox,
  collapsed,
  onToggle,
}: GithubInboxSectionProps) {
  const { t } = useI18n();
  const { query, refresh } = inbox;
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
          <GithubRefreshButton onRefresh={refresh} refreshing={query.isFetching} />
        </>
      }
    >
      <InboxBody chatId={chatId} query={query} />
    </GithubSection>
  );
}

/**
 * Split from the section shell so the query's four-way degradation is one
 * function with early returns instead of a chain of ternaries in JSX.
 */
function InboxBody({
  chatId,
  query,
}: {
  readonly chatId: string;
  readonly query: GithubInbox['query'];
}) {
  const { t } = useI18n();

  if (query.isPending) {
    return <EmptyState icon={<Spinner />} title={t.github.loading} className="min-h-24 py-4" />;
  }
  if (query.isError || !query.data) {
    return <Callout tone="danger" title={t.github.errors.inbox} />;
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
        <GithubRowShell key={item.url}>
          {/* An anchor, not a button: an inbox row is in another repository,
              so there is no local detail view to open — the browser is the
              destination and middle-click should behave like one. */}
          <a href={item.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-fg">{item.title}</span>
            <span className="mt-0.5 block truncate font-mono text-xs text-fg-muted">
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
        </GithubRowShell>
      ))}
    </ul>
  );
}
