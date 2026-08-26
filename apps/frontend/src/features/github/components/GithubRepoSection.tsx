import type {
  GithubIssueFilter,
  GithubIssuesResponse,
  GithubPrFilter,
  GithubPrsResponse,
  GithubUnavailableState,
} from '@mangostudio/shared/github';
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, GitPullRequest, Plus, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG, ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import { checkoutPullRequest } from '../api';
import { useIssueToNewChat } from '../hooks/use-issue-to-new-chat';
import type { GithubPanelPrefs } from '../lib/github-panel-prefs';
import { githubIssuesQueryOptions, githubPrsQueryOptions } from '../queries';
import { CreatePrForm } from './CreatePrForm';
import { GithubIssueRow } from './GithubIssueRow';
import { GithubNotConnected } from './GithubNotConnected';
import { GithubPrDetail } from './GithubPrDetail';
import { GithubPrRow } from './GithubPrRow';
import { GithubSection } from './GithubSection';
import { GithubRefreshButton, GithubStaleness } from './GithubStaleness';

/** The rail's testid for the repository-scoped half of the panel. */
const GITHUB_REPO_TESTID = 'github-repo-section';

/** The two lists this section can show. A tab is UI state, not a server filter. */
type RepoTab = 'prs' | 'issues';

/**
 * The browsable pull-request filters. `all` is deliberately absent: it exists
 * for the branch list's merged-branch annotation, and a view full of long-closed
 * pull requests is not one anybody scrolls through on purpose.
 */
const PR_FILTERS: readonly GithubPrFilter[] = ['open', 'mine', 'review-requested'];
const ISSUE_FILTERS: readonly GithubIssueFilter[] = ['open', 'assigned', 'mine'];

interface GithubRepoSectionProps {
  readonly chatId: string;
  readonly workdir: string | null;
  /** True when the branch has no upstream, so creating a PR must push first. */
  readonly needsPush: boolean;
  readonly branchName: string | null;
  readonly prefs: GithubPanelPrefs;
  readonly onPrefsChange: (prefs: GithubPanelPrefs) => void;
}

/**
 * Everything about the repository the active chat is pointed at.
 *
 * Gated on the workdir *here* rather than in the panel's availability, because
 * the inbox above it is not repo-scoped: a chat with no folder still has a
 * review queue worth showing, and hiding the whole panel to protect this half
 * would hide that too.
 *
 * Only the visible tab's query is enabled. Each list is a live `gh` subprocess
 * on somebody's machine, so fetching the issues nobody is looking at costs a
 * process to fill a list that is not on screen.
 *
 * @example
 * <GithubRepoSection chatId={chatId} workdir={workdir} needsPush={false} branchName="feat/x" prefs={prefs} onPrefsChange={setPrefs} />
 */
export function GithubRepoSection({
  chatId,
  workdir,
  needsPush,
  branchName,
  prefs,
  onPrefsChange,
}: GithubRepoSectionProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<RepoTab>('prs');
  const [selectedPr, setSelectedPr] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  const prsQuery = useQuery({
    ...githubPrsQueryOptions(chatId, prefs.prFilter),
    enabled: Boolean(workdir) && tab === 'prs',
  });
  const issuesQuery = useQuery({
    ...githubIssuesQueryOptions(chatId, prefs.issueFilter),
    enabled: Boolean(workdir) && tab === 'issues',
  });
  const activeQuery = tab === 'prs' ? prsQuery : issuesQuery;
  const cachedAt = activeQuery.data?.state === 'ok' ? activeQuery.data.cachedAt : null;

  return (
    <GithubSection
      label={t.github.panel.repo}
      testId={GITHUB_REPO_TESTID}
      collapsed={prefs.repoCollapsed}
      onToggle={() => onPrefsChange({ ...prefs, repoCollapsed: !prefs.repoCollapsed })}
      action={
        workdir ? (
          <>
            <GithubStaleness cachedAt={cachedAt} refreshing={activeQuery.isFetching} />
            <GithubRefreshButton
              onRefresh={() => void activeQuery.refetch()}
              refreshing={activeQuery.isFetching}
            />
          </>
        ) : null
      }
    >
      {workdir ? (
        <div className="space-y-2">
          <TabBar
            tab={tab}
            onSelect={(next) => {
              setTab(next);
              // Leaving the pull requests behind leaves the open one too:
              // returning to a detail view you did not ask for is disorienting.
              setSelectedPr(null);
            }}
          />
          {tab === 'prs' ? (
            <PrsPane
              chatId={chatId}
              branchName={branchName}
              needsPush={needsPush}
              creating={creating}
              onCreatingChange={setCreating}
              selectedPr={selectedPr}
              onSelectPr={setSelectedPr}
              prefs={prefs}
              onPrefsChange={onPrefsChange}
              query={prsQuery}
            />
          ) : (
            <IssuesPane
              chatId={chatId}
              workdir={workdir}
              prefs={prefs}
              onPrefsChange={onPrefsChange}
              query={issuesQuery}
            />
          )}
        </div>
      ) : (
        // The one deterministic empty state on this panel: a chat with no folder
        // bound has no repository, whatever `gh` would otherwise have said.
        <EmptyState
          icon={<FolderOpen size={ICON_LG} />}
          title={t.github.panel.noWorkdir}
          className="min-h-24 py-4"
        />
      )}
    </GithubSection>
  );
}

function TabBar({
  tab,
  onSelect,
}: {
  readonly tab: RepoTab;
  readonly onSelect: (tab: RepoTab) => void;
}) {
  const { t } = useI18n();
  const labels: Readonly<Record<RepoTab, string>> = {
    prs: t.github.panel.prs,
    issues: t.github.panel.issues,
  };

  return (
    <div role="tablist" aria-label={t.github.panel.repo} className="flex gap-1">
      {(['prs', 'issues'] as const).map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          onClick={() => onSelect(id)}
          className={`cursor-pointer rounded-lg px-2 py-1 text-[10px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-primary ${
            tab === id
              ? 'bg-primary/12 text-primary'
              : 'text-on-surface-variant hover:bg-surface-container-high'
          }`}
        >
          {labels[id]}
        </button>
      ))}
    </div>
  );
}

/** The filter row, generic over the two closed filter unions the lists take. */
function FilterBar<T extends string>({
  filters,
  active,
  labels,
  onSelect,
}: {
  readonly filters: readonly T[];
  readonly active: T;
  readonly labels: Readonly<Record<string, string>>;
  readonly onSelect: (filter: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {filters.map((filter) => (
        <button
          key={filter}
          type="button"
          aria-pressed={filter === active}
          onClick={() => onSelect(filter)}
          className={`cursor-pointer rounded-full px-2 py-0.5 text-[10px] transition-colors focus-visible:outline-2 focus-visible:outline-primary ${
            filter === active
              ? 'bg-surface-container-highest text-on-surface'
              : 'text-on-surface-variant hover:text-on-surface'
          }`}
        >
          {labels[filter]}
        </button>
      ))}
    </div>
  );
}

function PrsPane({
  chatId,
  branchName,
  needsPush,
  creating,
  onCreatingChange,
  selectedPr,
  onSelectPr,
  prefs,
  onPrefsChange,
  query,
}: {
  readonly chatId: string;
  readonly branchName: string | null;
  readonly needsPush: boolean;
  readonly creating: boolean;
  readonly onCreatingChange: (creating: boolean) => void;
  readonly selectedPr: number | null;
  readonly onSelectPr: (number: number | null) => void;
  readonly prefs: GithubPanelPrefs;
  readonly onPrefsChange: (prefs: GithubPanelPrefs) => void;
  readonly query: UseQueryResult<GithubPrsResponse, Error>;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const checkout = useMutation({
    mutationFn: (number: number) => checkoutPullRequest({ chatId, number }),
    onSuccess: async (result) => {
      if (result.state !== 'ok') {
        toast(t.github.connection[result.state], 'error');
        return;
      }
      // The branch just changed under the chat, so every branch-scoped read —
      // the Git panel's state included — is now answering about the old ref.
      await queryClient.invalidateQueries();
    },
    onError: (error) => toast(resolveApiErrorMessage(error, t.github.errors.action), 'error'),
  });

  if (selectedPr !== null) {
    return <GithubPrDetail chatId={chatId} number={selectedPr} onBack={() => onSelectPr(null)} />;
  }

  return (
    <div className="space-y-2">
      <FilterBar
        filters={PR_FILTERS}
        active={prefs.prFilter}
        labels={t.github.prFilter}
        onSelect={(prFilter) => onPrefsChange({ ...prefs, prFilter })}
      />
      {creating ? (
        <CreatePrForm
          chatId={chatId}
          needsPush={needsPush}
          defaultTitle={branchName ?? ''}
          onDone={() => onCreatingChange(false)}
        />
      ) : (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onCreatingChange(true)}
          className="w-full"
        >
          <Plus size={ICON_SM} />
          {t.github.actions.createPr}
        </Button>
      )}
      <ListGate query={query} errorLabel={t.github.errors.prs} emptyLabel={t.github.empty.prs}>
        {(payload) =>
          payload.prs.map((pr) => (
            <GithubPrRow
              key={pr.number}
              chatId={chatId}
              nameWithOwner={payload.repo.nameWithOwner}
              pr={pr}
              onOpen={onSelectPr}
              onCheckout={(number) => checkout.mutate(number)}
            />
          ))
        }
      </ListGate>
    </div>
  );
}

function IssuesPane({
  chatId,
  workdir,
  prefs,
  onPrefsChange,
  query,
}: {
  readonly chatId: string;
  readonly workdir: string;
  readonly prefs: GithubPanelPrefs;
  readonly onPrefsChange: (prefs: GithubPanelPrefs) => void;
  readonly query: UseQueryResult<GithubIssuesResponse, Error>;
}) {
  const { t } = useI18n();
  const startChat = useIssueToNewChat(chatId, workdir);

  return (
    <div className="space-y-2">
      <FilterBar
        filters={ISSUE_FILTERS}
        active={prefs.issueFilter}
        labels={t.github.issueFilter}
        onSelect={(issueFilter) => onPrefsChange({ ...prefs, issueFilter })}
      />
      <ListGate
        query={query}
        errorLabel={t.github.errors.issues}
        emptyLabel={t.github.empty.issues}
      >
        {(payload) =>
          payload.issues.map((issue) => (
            <GithubIssueRow
              key={issue.number}
              chatId={chatId}
              nameWithOwner={payload.repo.nameWithOwner}
              issue={issue}
              onStartChat={(target) => void startChat(target)}
            />
          ))
        }
      </ListGate>
    </div>
  );
}

/**
 * The loading / error / not-connected / empty ladder every list climbs.
 *
 * One component because both lists degrade identically, and two copies of this
 * ladder is two places for the not-connected branch to drift — the same
 * reasoning that made the four unavailable states one shared union in the
 * contract.
 *
 * `EmptyState` for loading rather than a skeleton: that is the rail's idiom,
 * and `HubSkeletonLines` belongs to the home hub.
 */
function ListGate<TOk extends { state: 'ok' }>({
  query,
  errorLabel,
  emptyLabel,
  children,
}: {
  readonly query: UseQueryResult<TOk | GithubUnavailableState, Error>;
  readonly errorLabel: string;
  readonly emptyLabel: string;
  readonly children: (payload: TOk) => ReactNode[];
}) {
  const { t } = useI18n();

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
    return <EmptyState title={errorLabel} tone="error" className="min-h-24 py-4" />;
  }
  if (query.data.state !== 'ok') return <GithubNotConnected state={query.data.state} />;

  const rows = children(query.data as TOk);
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<GitPullRequest size={ICON_LG} />}
        title={emptyLabel}
        className="min-h-24 py-4"
      />
    );
  }

  return <ul className="space-y-0.5">{rows}</ul>;
}
