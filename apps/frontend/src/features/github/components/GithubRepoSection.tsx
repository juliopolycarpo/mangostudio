import type {
  GithubIssuesResponse,
  GithubPrsResponse,
  GithubUnavailableState,
} from '@mangostudio/shared/github';
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, GitPullRequest, Plus, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { gitWriteScopes, invalidateGitScopes } from '@/features/workspace/hooks/use-git-state';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG, ICON_SM } from '@/lib/icon-sizes';
import { resolveApiErrorMessage } from '@/lib/utils';
import { checkoutPullRequest } from '../api';
import { useIssueToNewChat } from '../hooks/use-issue-to-new-chat';
import { type GithubPanelPrefs, ISSUE_FILTERS, PR_FILTERS } from '../lib/github-panel-prefs';
import { onGithubCreatePrRequest } from '../lib/github-panel-request';
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

interface GithubRepoSectionProps {
  readonly chatId: string;
  readonly workdir: string | null;
  /** True when the branch has no upstream, so creating a PR must push first. */
  readonly needsPush: boolean;
  readonly branchName: string | null;
  /** True while the git query that fills `branchName` is still in flight. */
  readonly branchLoading: boolean;
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
  branchLoading,
  prefs,
  onPrefsChange,
}: GithubRepoSectionProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<RepoTab>('prs');
  const [selectedPr, setSelectedPr] = useState<number | null>(null);
  // Owned here rather than by `PrsPane`, which owns `creating` itself: a
  // request can arrive while `PrsPane` is not even mounted yet (the tab was
  // on issues), so the flag has to survive the tab switch that mounts it.
  // `PrsPane` clears it once it has opened the form.
  const [pendingCreatePr, setPendingCreatePr] = useState(false);

  useEffect(
    () =>
      onGithubCreatePrRequest(() => {
        setTab('prs');
        setSelectedPr(null);
        setPendingCreatePr(true);
      }),
    []
  );

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
              branchLoading={branchLoading}
              needsPush={needsPush}
              selectedPr={selectedPr}
              onSelectPr={setSelectedPr}
              prefs={prefs}
              onPrefsChange={onPrefsChange}
              query={prsQuery}
              openCreateForm={pendingCreatePr}
              onCreateFormOpened={() => setPendingCreatePr(false)}
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
  branchLoading,
  needsPush,
  selectedPr,
  onSelectPr,
  prefs,
  onPrefsChange,
  query,
  openCreateForm,
  onCreateFormOpened,
}: {
  readonly chatId: string;
  readonly branchName: string | null;
  readonly branchLoading: boolean;
  readonly needsPush: boolean;
  readonly selectedPr: number | null;
  readonly onSelectPr: (number: number | null) => void;
  readonly prefs: GithubPanelPrefs;
  readonly onPrefsChange: (prefs: GithubPanelPrefs) => void;
  readonly query: UseQueryResult<GithubPrsResponse, Error>;
  /** True for one render: a `requestGithubCreatePr` reached this pane already mounted. */
  readonly openCreateForm: boolean;
  readonly onCreateFormOpened: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Owned here rather than by the section above, so leaving the tab closes the
  // form. `CreatePrForm` holds the typed title and body in its own state and
  // unmounts with this pane either way; a flag that outlived it brought the
  // form back empty, discarding the draft while still looking like it was open.
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!openCreateForm) return;
    // A request that arrived before the git query settled can't yet tell a
    // detached checkout from a branch that just hasn't loaded — consuming it
    // here would open nothing and never get another chance. Wait for the
    // query so the outcome below is a real answer, not a guess mid-flight.
    if (branchLoading) return;
    // A detached checkout has no branch for `readCurrentBranch()` to name, and
    // `gh pr create` needs one — opening the form here would only trade the
    // button's own gate below for a submit that fails with a generic error.
    if (branchName) setCreating(true);
    onCreateFormOpened();
  }, [openCreateForm, onCreateFormOpened, branchName, branchLoading]);

  const checkout = useMutation({
    mutationFn: (number: number) => checkoutPullRequest({ chatId, number }),
    onSuccess: async (result) => {
      if (result.state !== 'ok') {
        toast(t.github.connection[result.state], 'error');
        return;
      }
      // The branch just changed under the chat, so every branch-scoped read —
      // the Git panel's state included — is now answering about the old ref.
      // `gh pr checkout` fetches a ref and switches onto it, which is what
      // `checkoutRemote` already describes, so it reuses that scope list rather
      // than declaring a parallel one that would drift from it. That scope
      // list includes `github`, which `invalidateGitScopes` already resolves
      // to `githubKeys.all` too, so this needs no separate call of its own.
      await invalidateGitScopes(queryClient, chatId, gitWriteScopes.checkoutRemote);
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
          onDone={() => setCreating(false)}
        />
      ) : branchName ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setCreating(true)}
          className="w-full"
        >
          <Plus size={ICON_SM} />
          {t.github.actions.createPr}
        </Button>
      ) : (
        // A detached HEAD (or a checkout `readCurrentBranch()` otherwise
        // cannot name) has no branch for `gh pr create` to push, and the
        // command fails with a generic server error rather than explaining
        // why — so this state is caught here instead.
        <p className="text-[10px] leading-4 text-on-surface-variant">
          {t.github.createPr.noBranch}
        </p>
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
