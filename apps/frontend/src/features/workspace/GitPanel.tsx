import type {
  GitFileChange,
  GitFileStatus,
  GitRepoState,
  GitStatus,
} from '@mangostudio/shared/git';
import type { GithubContext, GithubPrState } from '@mangostudio/shared/github';
import type { Messages } from '@mangostudio/shared/i18n';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  FileCode2,
  FolderGit2,
  GitPullRequest,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { BranchControl } from './BranchControl';
import { CommitForm } from './CommitForm';
import { type DiffSelection, DiffViewer } from './DiffViewer';
import { readGitPanelPrefs, writeGitPanelPrefs } from './git-panel-prefs';
import {
  type GitDiscardSelection,
  useDiscardPaths,
  useGitState,
  useInitRepo,
  useStagePaths,
  useUnstagePaths,
} from './hooks/use-git-state';
import { useGithubContext } from './hooks/use-github-context';
import { RemoteActions } from './RemoteActions';
import { RepositoryHistory } from './RepositoryHistory';
import { StashSheet } from './StashSheet';

interface GitPanelProps {
  readonly chatId: string;
}

interface StatusPresentation {
  readonly glyph: string;
  readonly labelKey: keyof Messages['git']['status'];
  readonly color: string;
}

const STATUS_PRESENTATION: Readonly<Record<GitFileStatus, StatusPresentation>> = {
  modified: { glyph: 'M', labelKey: 'modified', color: 'text-warning' },
  added: { glyph: 'A', labelKey: 'added', color: 'text-success' },
  deleted: { glyph: 'D', labelKey: 'deleted', color: 'text-error' },
  renamed: { glyph: 'R', labelKey: 'renamed', color: 'text-primary' },
  copied: { glyph: 'C', labelKey: 'copied', color: 'text-primary' },
  untracked: { glyph: '?', labelKey: 'untracked', color: 'text-on-surface-variant' },
  conflicted: { glyph: '!', labelKey: 'conflicted', color: 'text-error' },
  'type-changed': { glyph: 'T', labelKey: 'typeChanged', color: 'text-warning' },
};

export function GitPanel({ chatId }: GitPanelProps) {
  const { t } = useI18n();
  const labels = t.git;
  const stateQuery = useGitState(chatId);
  const githubQuery = useGithubContext(chatId, stateQuery.data);
  const initMutation = useInitRepo(chatId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [stashOpen, setStashOpen] = useState(false);
  const [prefs, setPrefs] = useState(readGitPanelPrefs);
  const isFetching = stateQuery.isFetching || githubQuery.isFetching;
  const isRepo = stateQuery.data?.state === 'repo';

  const refresh = async () => {
    const requests: Array<Promise<unknown>> = [stateQuery.refetch()];
    if (stateQuery.data?.state === 'repo') requests.push(githubQuery.refetch());
    await Promise.all(requests);
  };

  const togglePrune = () => {
    const next = { ...prefs, pruneOnFetch: !prefs.pruneOnFetch };
    setPrefs(next);
    writeGitPanelPrefs(next);
  };

  return (
    <section aria-label={labels.title} className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-outline-variant/15 px-3">
        <div className="min-w-0 flex-1 text-on-surface-variant">
          <RepositoryName state={stateQuery.data} />
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          aria-label={labels.refresh}
          title={labels.refresh}
          disabled={isFetching}
          className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-primary"
        >
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : undefined} />
        </button>
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          trigger={(triggerProps) => (
            <button
              type="button"
              aria-label={labels.menu.open}
              title={labels.menu.open}
              className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
              {...triggerProps}
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        >
          <MenuItem
            disabled={!isRepo}
            onSelect={() => {
              setMenuOpen(false);
              setStashOpen(true);
            }}
          >
            {labels.menu.stash}
          </MenuItem>
          <MenuItem checked={prefs.pruneOnFetch} onSelect={togglePrune}>
            {labels.menu.prune}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            disabled={isFetching}
            onSelect={() => {
              setMenuOpen(false);
              void refresh();
            }}
          >
            {labels.menu.refresh}
          </MenuItem>
        </Menu>
      </div>

      {/*
        No live region here: the file list re-renders on every refetch, and
        announcing it would interrupt the user. The panel is a labelled region
        that screen-reader users navigate to when they want it.
      */}
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
        <GitPanelContent
          chatId={chatId}
          state={stateQuery.data}
          loading={stateQuery.isLoading}
          error={stateQuery.error}
          githubContext={githubQuery.data}
          githubLoading={githubQuery.isLoading}
          githubError={githubQuery.error}
          initPending={initMutation.isPending}
          initError={initMutation.error}
          onInitialize={() => initMutation.mutate()}
          onRetry={() => void stateQuery.refetch()}
          onGithubRetry={() => void githubQuery.refetch()}
        />
      </div>

      {stashOpen && isRepo ? (
        <StashSheet chatId={chatId} onClose={() => setStashOpen(false)} />
      ) : null}
    </section>
  );
}

function RepositoryName({ state }: { readonly state: GitRepoState | undefined }) {
  if (!state || (state.state !== 'repo' && state.state !== 'not-a-repo')) return null;
  const path = state.state === 'repo' ? state.root : state.workdir;
  return (
    <p className="truncate font-mono text-[11px] text-on-surface-variant" title={path}>
      {basename(path)}
    </p>
  );
}

interface GitPanelContentProps {
  readonly chatId: string;
  readonly state: GitRepoState | undefined;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly githubContext: GithubContext | undefined;
  readonly githubLoading: boolean;
  readonly githubError: Error | null;
  readonly initPending: boolean;
  readonly initError: Error | null;
  readonly onInitialize: () => void;
  readonly onRetry: () => void;
  readonly onGithubRetry: () => void;
}

function GitPanelContent({
  chatId,
  state,
  loading,
  error,
  githubContext,
  githubLoading,
  githubError,
  initPending,
  initError,
  onInitialize,
  onRetry,
  onGithubRetry,
}: GitPanelContentProps) {
  const { t } = useI18n();
  const labels = t.git;

  if (error) {
    return (
      <PanelMessage icon={<AlertTriangle size={20} />} title={labels.loadError} tone="error">
        <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
          {t.common.retry}
        </Button>
      </PanelMessage>
    );
  }
  if (loading || !state) {
    return (
      <PanelMessage
        icon={<RefreshCw size={20} className="animate-spin" />}
        title={labels.loading}
      />
    );
  }

  switch (state.state) {
    case 'git-unavailable':
      return (
        <PanelMessage
          icon={<AlertTriangle size={20} />}
          title={labels.unavailableTitle}
          detail={labels.unavailableHint}
          tone="warning"
        />
      );
    case 'no-workdir':
      return <PanelMessage icon={<FolderGit2 size={20} />} title={labels.noWorkdir} />;
    case 'not-a-repo':
      return (
        <PanelMessage
          icon={<FolderGit2 size={22} />}
          title={labels.noRepositoryTitle}
          detail={labels.noRepositoryHint}
        >
          <Button
            type="button"
            size="sm"
            onClick={onInitialize}
            loading={initPending}
            disabled={initPending}
          >
            {initPending ? labels.initializing : labels.initialize}
          </Button>
          {initError ? <p className="text-xs text-error">{labels.initializeFailed}</p> : null}
        </PanelMessage>
      );
    case 'repo':
      return (
        // Keyed by chat so the view tab and the open diff reset with the repository.
        <RepositoryStatus
          key={chatId}
          chatId={chatId}
          status={state.status}
          githubContext={githubContext}
          githubLoading={githubLoading}
          githubError={githubError}
          onGithubRetry={onGithubRetry}
        />
      );
  }
}

function RepositoryStatus({
  chatId,
  status,
  githubContext,
  githubLoading,
  githubError,
  onGithubRetry,
}: {
  readonly chatId: string;
  readonly status: GitStatus;
  readonly githubContext: GithubContext | undefined;
  readonly githubLoading: boolean;
  readonly githubError: Error | null;
  readonly onGithubRetry: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const labels = t.git;
  const stageMutation = useStagePaths(chatId);
  const unstageMutation = useUnstagePaths(chatId);
  const discardMutation = useDiscardPaths(chatId);
  const [view, setView] = useState<'changes' | 'history'>('changes');
  const [diffSelection, setDiffSelection] = useState<DiffSelection | null>(null);
  // A bulk discard over the merged group needs one call per mode, so the
  // pending request is a list even when the user picked a single file.
  const [discardRequest, setDiscardRequest] = useState<GitDiscardSelection[] | null>(null);
  // Shared so the recovery banner appears whether the push came from the branch
  // row or from a commit chain.
  const [remoteFailure, setRemoteFailure] = useState<unknown>(null);
  const branchName = status.branch.name
    ? status.branch.name
    : labels.detachedAt.replace('{commit}', status.branch.detachedAt?.slice(0, 8) ?? 'HEAD');

  // A rejected remote operation describes the branch it was rejected on. Its
  // guidance — and the leased force push it can offer — must not survive a
  // checkout onto a different branch.
  useEffect(() => setRemoteFailure(null), [status.branch.name]);

  const mutatePaths = async (action: 'stage' | 'unstage', paths: string[] | { all: true }) => {
    try {
      if (action === 'stage') {
        await stageMutation.mutateAsync(Array.isArray(paths) ? { paths } : paths);
      } else {
        await unstageMutation.mutateAsync(Array.isArray(paths) ? { paths } : paths);
      }
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.actions.failed), 'error');
    }
  };

  const confirmDiscard = async () => {
    if (!discardRequest) return;
    try {
      // Sequential: the two modes touch the same worktree, and a failed delete
      // must not be masked by a restore that ran beside it.
      for (const selection of discardRequest) {
        await discardMutation.mutateAsync(selection);
      }
      toast(discardSuccessLabel(discardRequest, labels.discard), 'success');
      setDiscardRequest(null);
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.actions.failed), 'error');
    }
  };

  const changes = [...status.unstaged, ...status.untracked];
  const hasUnstagedWork = changes.length > 0 || status.conflicted.length > 0;
  const anyPending =
    stageMutation.isPending || unstageMutation.isPending || discardMutation.isPending;

  return (
    <div className="space-y-4">
      <section aria-label={branchName} className="relative z-20 flex flex-wrap items-center gap-1">
        <div className="min-w-0 flex-1">
          <BranchControl chatId={chatId} branch={status.branch} detachedLabel={branchName} />
        </div>
        <RemoteActions
          chatId={chatId}
          branch={status.branch}
          failure={remoteFailure}
          onFailureChange={setRemoteFailure}
        />
        {status.branch.upstream ? (
          <p
            className="w-full truncate pl-6 font-mono text-[11px] text-on-surface-variant"
            title={status.branch.upstream}
          >
            {status.branch.upstream}
          </p>
        ) : null}
      </section>

      <div className="grid grid-cols-2 rounded-xl bg-surface-container/60 p-1" role="tablist">
        {(['changes', 'history'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={view === tab}
            onClick={() => {
              setView(tab);
              setDiffSelection(null);
            }}
            className={`cursor-pointer rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors ${
              view === tab
                ? 'bg-surface-container-highest text-on-surface shadow-sm'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            {labels.navigation[tab]}
          </button>
        ))}
      </div>

      {view === 'history' ? (
        diffSelection ? (
          <DiffViewer
            chatId={chatId}
            selection={diffSelection}
            onClose={() => setDiffSelection(null)}
          />
        ) : (
          <RepositoryHistory chatId={chatId} onOpenDiff={setDiffSelection} />
        )
      ) : (
        // CommitForm stays mounted while a diff is open: it holds the in-progress
        // commit message in local state, and unmounting it would discard the draft.
        <>
          <CommitForm
            chatId={chatId}
            branch={status.branch}
            hasChanges={!status.clean}
            hasStagedChanges={status.staged.length > 0}
            hasUnstagedWork={hasUnstagedWork}
            onRemoteFailure={setRemoteFailure}
          />
          {diffSelection ? (
            <DiffViewer
              chatId={chatId}
              selection={diffSelection}
              onClose={() => setDiffSelection(null)}
            />
          ) : status.clean ? (
            <PanelMessage
              icon={<Check size={22} />}
              title={labels.cleanTitle}
              detail={labels.cleanHint}
              tone="success"
            />
          ) : (
            <div className="space-y-4">
              {status.conflicted.length > 0 ? (
                <div className="rounded-xl border border-error/30 bg-error/10 px-3 py-2.5 text-[11px] leading-4 text-error">
                  {labels.conflicts.hint}
                </div>
              ) : null}
              <ChangeGroup
                title={labels.groups.conflicted}
                changes={status.conflicted}
                action="stage"
                pending={anyPending}
                onAction={(paths) => void mutatePaths('stage', paths)}
                onDiff={(path) =>
                  setDiffSelection({ path, title: labels.diff.view.replace('{path}', path) })
                }
              />
              <ChangeGroup
                title={labels.groups.changes}
                changes={changes}
                action="stage"
                pending={anyPending}
                onAction={(paths) => void mutatePaths('stage', paths)}
                onDiscard={setDiscardRequest}
                onDiff={(path) =>
                  setDiffSelection({ path, title: labels.diff.view.replace('{path}', path) })
                }
              />
              <ChangeGroup
                title={labels.groups.staged}
                changes={status.staged}
                action="unstage"
                pending={anyPending}
                onAction={(paths) => void mutatePaths('unstage', paths)}
                onDiff={(path) =>
                  setDiffSelection({
                    path,
                    staged: true,
                    title: labels.diff.view.replace('{path}', path),
                  })
                }
              />
            </div>
          )}
        </>
      )}

      <GithubSection
        context={githubContext}
        loading={githubLoading}
        error={githubError}
        onRetry={onGithubRetry}
      />

      {discardRequest ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="git-discard-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-sm space-y-4 rounded-3xl border border-outline-variant/20 bg-surface-container-high p-6 shadow-2xl">
            <div className="space-y-2">
              <h3 id="git-discard-title" className="text-lg font-bold text-on-surface">
                {discardCopy(discardRequest, labels.discard).title}
              </h3>
              <p className="text-sm leading-5 text-on-surface-variant">
                {discardCopy(discardRequest, labels.discard).hint}
              </p>
            </div>
            <ul className="max-h-32 overflow-y-auto rounded-xl bg-surface-container-lowest p-2 font-mono text-[11px]">
              {discardRequest
                .flatMap((selection) => selection.paths)
                .map((path) => (
                  <li key={path} className="truncate py-0.5" title={path}>
                    {path}
                  </li>
                ))}
            </ul>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => setDiscardRequest(null)}
              >
                {labels.discard.cancel}
              </Button>
              <Button
                type="button"
                className="flex-1"
                loading={discardMutation.isPending}
                onClick={() => void confirmDiscard()}
              >
                {discardCopy(discardRequest, labels.discard).confirm}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type DiscardLabels = Messages['git']['discard'];

function discardModes(selections: readonly GitDiscardSelection[]) {
  return {
    tracked: selections.some((selection) => selection.mode === 'tracked'),
    untracked: selections.some((selection) => selection.mode === 'untracked'),
  };
}

/** Deleting untracked files is not undoable, so a mixed discard must say so. */
function discardCopy(selections: readonly GitDiscardSelection[], labels: DiscardLabels) {
  const modes = discardModes(selections);
  if (modes.tracked && modes.untracked) {
    return { title: labels.mixedTitle, hint: labels.mixedHint, confirm: labels.confirmMixed };
  }
  if (modes.untracked) {
    return { title: labels.deleteTitle, hint: labels.deleteHint, confirm: labels.confirmDelete };
  }
  return { title: labels.restoreTitle, hint: labels.restoreHint, confirm: labels.confirmRestore };
}

function discardSuccessLabel(
  selections: readonly GitDiscardSelection[],
  labels: DiscardLabels
): string {
  const modes = discardModes(selections);
  if (modes.tracked && modes.untracked) return labels.mixedDone;
  return modes.untracked ? labels.deleted : labels.restored;
}

function discardModeFor(change: GitFileChange): GitDiscardSelection['mode'] {
  return change.status === 'untracked' ? 'untracked' : 'tracked';
}

/** Splits a mixed group into the one call per mode the discard contract takes. */
function splitDiscardSelections(changes: readonly GitFileChange[]): GitDiscardSelection[] {
  const selections: GitDiscardSelection[] = [];
  for (const mode of ['tracked', 'untracked'] as const) {
    const paths = changePaths(changes.filter((change) => discardModeFor(change) === mode));
    if (paths.length > 0) selections.push({ paths, mode });
  }
  return selections;
}

function GithubSection({
  context,
  loading,
  error,
  onRetry,
}: {
  readonly context: GithubContext | undefined;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly onRetry: () => void;
}) {
  const { t } = useI18n();
  const labels = t.github;
  const [expanded, setExpanded] = useState(false);

  if (context?.state === 'no-remote' || context?.state === 'not-a-github-remote') return null;

  let content: ReactNode;
  if (error && !context) {
    content = (
      <div className="flex items-center gap-2 text-xs text-error">
        <span className="min-w-0 flex-1">{labels.loadError}</span>
        <button
          type="button"
          onClick={onRetry}
          className="cursor-pointer rounded px-1.5 py-1 text-[10px] font-semibold text-primary hover:bg-primary/10"
        >
          {t.common.retry}
        </button>
      </div>
    );
  } else if (loading || !context) {
    content = <p className="text-xs text-on-surface-variant">{labels.loading}</p>;
  } else if (context.state === 'gh-not-installed') {
    content = <p className="text-xs leading-5 text-on-surface-variant">{labels.installHint}</p>;
  } else if (context.state === 'not-authenticated') {
    content = (
      <p className="font-mono text-xs leading-5 text-on-surface-variant">{labels.authHint}</p>
    );
  } else {
    content = (
      <div className="space-y-2.5">
        <div>
          <a
            href={context.repo.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1.5 text-xs font-semibold text-on-surface hover:text-primary"
          >
            <span className="truncate">{context.repo.nameWithOwner}</span>
            <ExternalLink size={11} className="shrink-0" aria-hidden="true" />
          </a>
          <p className="mt-0.5 text-[10px] text-on-surface-variant">
            {labels.defaultBranch.replace('{branch}', context.repo.defaultBranch)}
          </p>
        </div>
        {context.pr ? (
          <div className="rounded-lg border border-outline-variant/15 bg-surface-container-lowest/40 p-2.5">
            <div className="flex items-start gap-2">
              <a
                href={context.pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 flex-1 text-xs font-semibold leading-4 text-on-surface hover:text-primary"
              >
                #{context.pr.number} {context.pr.title}
              </a>
              <GithubPrBadge state={context.pr.state} draft={context.pr.isDraft} />
            </div>
            <p className="mt-1.5 truncate font-mono text-[10px] text-on-surface-variant">
              {labels.refs
                .replace('{base}', context.pr.baseRefName)
                .replace('{head}', context.pr.headRefName)}
            </p>
          </div>
        ) : (
          <p className="text-xs text-on-surface-variant">{labels.noPr}</p>
        )}
      </div>
    );
  }

  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="rounded-xl border border-outline-variant/15 bg-surface-container/35 p-3"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] font-bold uppercase tracking-[0.12em] text-on-surface-variant [&::-webkit-details-marker]:hidden">
        <GitPullRequest size={14} className="text-primary" />
        {labels.title}
      </summary>
      <div className="mt-3">{content}</div>
    </details>
  );
}

function GithubPrBadge({
  state,
  draft,
}: {
  readonly state: GithubPrState;
  readonly draft: boolean;
}) {
  const { t } = useI18n();
  const label = draft
    ? t.github.states.draft
    : t.github.states[state.toLowerCase() as Lowercase<GithubPrState>];
  const tone = draft
    ? 'bg-warning/15 text-warning'
    : state === 'OPEN'
      ? 'bg-success/15 text-success'
      : state === 'MERGED'
        ? 'bg-primary/15 text-primary'
        : 'bg-surface-container-high text-on-surface-variant';

  return (
    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase ${tone}`}>
      {label}
    </span>
  );
}

function ChangeGroup({
  title,
  changes,
  action,
  pending,
  onAction,
  onDiscard,
  onDiff,
}: {
  readonly title: string;
  readonly changes: readonly GitFileChange[];
  readonly action: 'stage' | 'unstage';
  readonly pending: boolean;
  readonly onAction: (paths: string[]) => void;
  readonly onDiscard?: (selections: GitDiscardSelection[]) => void;
  readonly onDiff: (path: string) => void;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  if (changes.length === 0) return null;

  const allLabel =
    action === 'stage'
      ? t.git.actions.stageAll.replace('{group}', title)
      : t.git.actions.unstageAll.replace('{group}', title);
  const selections = onDiscard ? splitDiscardSelections(changes) : [];
  // The narrower variants only mean something once the group holds both kinds.
  const mixed = selections.length > 1;

  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.12em] text-on-surface-variant">
        <span>{title}</span>
        <span className="rounded-full bg-surface-container-high px-1.5 py-0.5 font-mono text-[9px] tracking-normal">
          {changes.length}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          {mixed && onDiscard ? (
            <Menu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              panelClassName="w-56"
              trigger={(triggerProps) => (
                <GroupButton
                  label={t.git.actions.groupMenu.replace('{group}', title)}
                  disabled={pending}
                  {...triggerProps}
                >
                  <MoreHorizontal size={13} />
                </GroupButton>
              )}
            >
              {selections.map((selection) => (
                <MenuItem
                  key={selection.mode}
                  tone="danger"
                  onSelect={() => {
                    setMenuOpen(false);
                    onDiscard([selection]);
                  }}
                >
                  {selection.mode === 'untracked'
                    ? t.git.discard.deleteAllButton
                    : t.git.discard.restoreAllButton}
                </MenuItem>
              ))}
            </Menu>
          ) : null}
          {onDiscard ? (
            <GroupButton
              label={t.git.discard.discardAll.replace('{group}', title)}
              tone="danger"
              disabled={pending}
              onClick={() => onDiscard(selections)}
            >
              <RotateCcw size={13} />
            </GroupButton>
          ) : null}
          <GroupButton
            label={allLabel}
            disabled={pending}
            onClick={() => onAction(changePaths(changes))}
          >
            {action === 'stage' ? <Plus size={13} /> : <Minus size={13} />}
          </GroupButton>
        </span>
      </h3>
      <ul className="overflow-hidden rounded-xl border border-outline-variant/15 bg-surface-container-lowest/40">
        {changes.map((change) => (
          <FileChangeRow
            key={`${change.status}:${change.oldPath ?? ''}:${change.path}`}
            change={change}
            action={action}
            pending={pending}
            onAction={() => onAction(changePaths([change]))}
            onDiscard={
              onDiscard
                ? () => onDiscard([{ paths: changePaths([change]), mode: discardModeFor(change) }])
                : undefined
            }
            onDiff={() => onDiff(change.path)}
          />
        ))}
      </ul>
    </section>
  );
}

function GroupButton({
  label,
  tone = 'default',
  disabled,
  children,
  ...props
}: {
  readonly label: string;
  readonly tone?: 'default' | 'danger';
  readonly disabled: boolean;
  readonly children: ReactNode;
  readonly onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={`flex size-6 cursor-pointer items-center justify-center rounded tracking-normal transition-colors disabled:cursor-wait disabled:opacity-50 ${
        tone === 'danger'
          ? 'text-on-surface-variant hover:bg-error/10 hover:text-error'
          : 'text-on-surface-variant hover:bg-primary/10 hover:text-primary'
      }`}
      {...props}
    >
      {children}
    </button>
  );
}

function FileChangeRow({
  change,
  action,
  pending,
  onAction,
  onDiscard,
  onDiff,
}: {
  readonly change: GitFileChange;
  readonly action: 'stage' | 'unstage';
  readonly pending: boolean;
  readonly onAction: () => void;
  readonly onDiscard?: () => void;
  readonly onDiff: () => void;
}) {
  const { t } = useI18n();
  const presentation = STATUS_PRESENTATION[change.status];
  const statusLabel = t.git.status[presentation.labelKey];
  const actionLabel = (action === 'stage' ? t.git.actions.stage : t.git.actions.unstage).replace(
    '{path}',
    change.path
  );
  const untracked = discardModeFor(change) === 'untracked';
  const discardLabel = (untracked ? t.git.discard.deletePath : t.git.discard.restorePath).replace(
    '{path}',
    change.path
  );
  return (
    <li className="group flex min-w-0 items-start gap-2 border-b border-outline-variant/10 px-2.5 py-2 last:border-b-0">
      <span
        className={`w-3 shrink-0 pt-px text-center font-mono text-[11px] font-bold ${presentation.color}`}
        title={statusLabel}
        aria-hidden="true"
      >
        {presentation.glyph}
      </span>
      <span className="sr-only">{statusLabel}</span>
      <FileCode2 size={13} className="mt-0.5 shrink-0 text-on-surface-variant/70" />
      <button
        type="button"
        onClick={onDiff}
        aria-label={t.git.actions.viewDiff.replace('{path}', change.path)}
        title={change.path}
        className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-[11px] leading-4 text-on-surface hover:text-primary"
      >
        {change.oldPath ? (
          <>
            <span className="text-on-surface-variant line-through">{change.oldPath}</span>
            <span className="px-1 text-on-surface-variant">→</span>
          </>
        ) : null}
        {change.path}
      </button>
      {onDiscard ? (
        <button
          type="button"
          aria-label={discardLabel}
          title={discardLabel}
          disabled={pending}
          onClick={onDiscard}
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-on-surface-variant opacity-60 transition-colors hover:bg-error/10 hover:text-error group-hover:opacity-100 disabled:cursor-wait disabled:opacity-30"
        >
          {untracked ? <Trash2 size={12} /> : <RotateCcw size={12} />}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={actionLabel}
        title={actionLabel}
        disabled={pending}
        onClick={onAction}
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-on-surface-variant opacity-60 transition-colors hover:bg-surface-container-high hover:text-primary group-hover:opacity-100 disabled:cursor-wait disabled:opacity-30"
      >
        {action === 'stage' ? <Plus size={13} /> : <Minus size={13} />}
      </button>
    </li>
  );
}

function changePaths(changes: readonly GitFileChange[]): string[] {
  return [
    ...new Set(
      changes.flatMap((change) => (change.oldPath ? [change.oldPath, change.path] : [change.path]))
    ),
  ];
}

function PanelMessage({
  icon,
  title,
  detail,
  tone = 'neutral',
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail?: string;
  readonly tone?: 'neutral' | 'error' | 'warning' | 'success';
  readonly children?: ReactNode;
}) {
  const toneClass = {
    neutral: 'text-on-surface-variant',
    error: 'text-error',
    warning: 'text-warning',
    success: 'text-success',
  }[tone];

  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-3 py-6 text-center">
      <span className={toneClass}>{icon}</span>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-on-surface">{title}</p>
        {detail ? <p className="text-xs leading-5 text-on-surface-variant">{detail}</p> : null}
      </div>
      {children}
    </div>
  );
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
