import type {
  GitFileChange,
  GitFileStatus,
  GitRepoState,
  GitStatus,
} from '@mangostudio/shared/git';
import type { GithubContext } from '@mangostudio/shared/github';
import type { Messages } from '@mangostudio/shared/i18n';
import {
  AlertTriangle,
  Check,
  FileCode2,
  FolderGit2,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { Spinner } from '@/components/ui/Spinner';
import { Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { ExternalReviewAction } from '@/features/external-agents/ExternalReviewAction';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG, ICON_SM } from '@/lib/icon-sizes';
import { workdirBasename } from '@/lib/paths';
import { cn, resolveApiErrorMessage } from '@/lib/utils';
import { BranchControl } from './BranchControl';
import { BranchPrChip } from './BranchPrChip';
import { CommitForm } from './CommitForm';
import { DialogPathList } from './components/DialogBlocks';
import { GroupHeading } from './components/GroupHeading';
import { IconButton } from './components/IconButton';
import { RowList } from './components/RowList';
import type { DiffSelection } from './DiffViewer';
import { readGitPanelPrefs, writeGitPanelPrefs } from './git-panel-prefs';
import {
  type GitDiscardSelection,
  useDiscardPaths,
  useGitRealtimeInvalidation,
  useGitState,
  useInitRepo,
  useStagePaths,
  useUnstagePaths,
} from './hooks/use-git-state';
import { useGithubContext } from './hooks/use-github-context';
import { LazyDiffViewer } from './LazyDiffViewer';
import { RemoteActions } from './RemoteActions';
import { RepositoryHistory } from './RepositoryHistory';
import { StashSheet } from './StashSheet';
import { WorktreeSection } from './WorktreeSection';

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
  deleted: { glyph: 'D', labelKey: 'deleted', color: 'text-danger' },
  renamed: { glyph: 'R', labelKey: 'renamed', color: 'text-info' },
  copied: { glyph: 'C', labelKey: 'copied', color: 'text-info' },
  untracked: { glyph: '?', labelKey: 'untracked', color: 'text-fg-muted' },
  conflicted: { glyph: '!', labelKey: 'conflicted', color: 'text-danger' },
  'type-changed': { glyph: 'T', labelKey: 'typeChanged', color: 'text-warning' },
};

export function GitPanel({ chatId }: GitPanelProps) {
  const { t } = useI18n();
  const labels = t.git;
  useGitRealtimeInvalidation(chatId);
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
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke px-4">
        <div className="min-w-0 flex-1">
          <RepositoryName state={stateQuery.data} />
        </div>
        <IconButton
          label={labels.refresh}
          onClick={() => void refresh()}
          disabled={isFetching}
          busy={isFetching}
        >
          <RefreshCw size={ICON_SM} className={isFetching ? 'animate-spin' : undefined} />
        </IconButton>
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          trigger={(triggerProps) => (
            <IconButton label={labels.menu.open} {...triggerProps}>
              <MoreHorizontal size={ICON_SM} />
            </IconButton>
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
          initPending={initMutation.isPending}
          initError={initMutation.error}
          onInitialize={() => initMutation.mutate()}
          onRetry={() => void stateQuery.refetch()}
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
    <p className="truncate font-mono text-xs text-fg-muted" title={path}>
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
  readonly initPending: boolean;
  readonly initError: Error | null;
  readonly onInitialize: () => void;
  readonly onRetry: () => void;
}

function GitPanelContent({
  chatId,
  state,
  loading,
  error,
  githubContext,
  initPending,
  initError,
  onInitialize,
  onRetry,
}: GitPanelContentProps) {
  const { t } = useI18n();
  const labels = t.git;

  if (error) {
    return (
      <Callout
        tone="danger"
        title={labels.loadError}
        action={
          <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
            {t.common.retry}
          </Button>
        }
      />
    );
  }
  if (loading || !state) {
    return <EmptyState icon={<Spinner />} title={labels.loading} />;
  }

  switch (state.state) {
    case 'git-unavailable':
      return (
        <EmptyState
          icon={<AlertTriangle size={ICON_LG} />}
          title={labels.unavailableTitle}
          hint={labels.unavailableHint}
          tone="warning"
        />
      );
    case 'no-workdir':
      return <EmptyState icon={<FolderGit2 size={ICON_LG} />} title={labels.noWorkdir} />;
    case 'not-a-repo':
      return (
        <EmptyState
          icon={<FolderGit2 size={ICON_LG} />}
          title={labels.noRepositoryTitle}
          hint={labels.noRepositoryHint}
          action={
            <>
              <Button
                type="button"
                size="sm"
                onClick={onInitialize}
                loading={initPending}
                disabled={initPending}
              >
                {initPending ? labels.initializing : labels.initialize}
              </Button>
              {initError ? <p className="text-xs text-danger">{labels.initializeFailed}</p> : null}
            </>
          }
        />
      );
    case 'repo':
      return (
        // Keyed by chat so the view tab and the open diff reset with the repository.
        <RepositoryStatus
          key={chatId}
          chatId={chatId}
          status={state.status}
          repoRoot={state.root}
          githubContext={githubContext}
        />
      );
  }
}

function RepositoryStatus({
  chatId,
  status,
  repoRoot,
  githubContext,
}: {
  readonly chatId: string;
  readonly status: GitStatus;
  readonly repoRoot: string;
  readonly githubContext: GithubContext | undefined;
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
  const discardText = discardRequest ? discardCopy(discardRequest, labels.discard) : null;
  const viewTabs = (['changes', 'history'] as const).map((id) => ({
    id,
    label: labels.navigation[id],
  }));

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
            className="w-full truncate pl-8 font-mono text-micro text-fg-subtle"
            title={status.branch.upstream}
          >
            {status.branch.upstream}
          </p>
        ) : null}
      </section>

      <Tabs
        tabs={viewTabs}
        active={view}
        onSelect={(next) => {
          setView(next);
          setDiffSelection(null);
        }}
      />

      {view === 'history' ? (
        diffSelection ? (
          <LazyDiffViewer
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
          {/*
            Above the commit form, because reviewing comes before committing —
            and nowhere near the composer's permissions dropdown, whose
            "Auto-review" option means something else entirely.
          */}
          <ExternalReviewAction chatId={chatId} hasChanges={!status.clean} />
          <CommitForm
            chatId={chatId}
            branch={status.branch}
            hasChanges={!status.clean}
            hasStagedChanges={status.staged.length > 0}
            hasUnstagedWork={hasUnstagedWork}
            onRemoteFailure={setRemoteFailure}
          />
          {diffSelection ? (
            <LazyDiffViewer
              chatId={chatId}
              selection={diffSelection}
              onClose={() => setDiffSelection(null)}
            />
          ) : status.clean ? (
            <EmptyState
              icon={<Check size={ICON_LG} />}
              title={labels.cleanTitle}
              hint={labels.cleanHint}
              tone="success"
            />
          ) : (
            <div className="space-y-4">
              {status.conflicted.length > 0 ? (
                <Callout tone="danger">{labels.conflicts.hint}</Callout>
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

      <WorktreeSection chatId={chatId} repoRoot={repoRoot} />

      <BranchPrChip chatId={chatId} context={githubContext} />

      {discardRequest && discardText ? (
        <Dialog
          size="sm"
          title={discardText.title}
          description={discardText.hint}
          onClose={() => setDiscardRequest(null)}
          footer={
            <>
              <Button type="button" variant="secondary" onClick={() => setDiscardRequest(null)}>
                {labels.discard.cancel}
              </Button>
              <Button
                type="button"
                variant="danger"
                loading={discardMutation.isPending}
                onClick={() => void confirmDiscard()}
              >
                {discardText.confirm}
              </Button>
            </>
          }
        >
          <DialogPathList paths={discardRequest.flatMap((selection) => selection.paths)} />
        </Dialog>
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
      <GroupHeading title={title} count={changes.length}>
        {mixed && onDiscard ? (
          <Menu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            panelClassName="w-56"
            trigger={(triggerProps) => (
              <IconButton
                label={t.git.actions.groupMenu.replace('{group}', title)}
                disabled={pending}
                {...triggerProps}
              >
                <MoreHorizontal size={ICON_SM} />
              </IconButton>
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
          <IconButton
            label={t.git.discard.discardAll.replace('{group}', title)}
            tone="danger"
            disabled={pending}
            onClick={() => onDiscard(selections)}
          >
            <RotateCcw size={ICON_SM} />
          </IconButton>
        ) : null}
        <IconButton
          label={allLabel}
          disabled={pending}
          onClick={() => onAction(changePaths(changes))}
        >
          {action === 'stage' ? <Plus size={ICON_SM} /> : <Minus size={ICON_SM} />}
        </IconButton>
      </GroupHeading>
      <RowList>
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
      </RowList>
    </section>
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
    <li className="flex min-h-8 min-w-0 items-center gap-2 px-3 py-0.5 transition-colors hover:bg-fill-hover">
      <span
        className={cn('w-4 shrink-0 text-center font-mono text-xs font-medium', presentation.color)}
        title={statusLabel}
        aria-hidden="true"
      >
        {presentation.glyph}
      </span>
      <span className="sr-only">{statusLabel}</span>
      <FileCode2 size={ICON_SM} className="shrink-0 text-fg-muted" />
      <button
        type="button"
        onClick={onDiff}
        aria-label={t.git.actions.viewDiff.replace('{path}', change.path)}
        title={change.path}
        className="min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-xs text-fg"
      >
        {change.oldPath ? (
          <>
            <span className="text-fg-muted line-through">{change.oldPath}</span>
            <span className="px-1 text-fg-muted">→</span>
          </>
        ) : null}
        {change.path}
      </button>
      {onDiscard ? (
        <IconButton label={discardLabel} tone="danger" disabled={pending} onClick={onDiscard}>
          {untracked ? <Trash2 size={ICON_SM} /> : <RotateCcw size={ICON_SM} />}
        </IconButton>
      ) : null}
      <IconButton label={actionLabel} disabled={pending} onClick={onAction}>
        {action === 'stage' ? <Plus size={ICON_SM} /> : <Minus size={ICON_SM} />}
      </IconButton>
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

/** Shared segment split; a path that is all separators falls back to itself. */
function basename(path: string): string {
  return workdirBasename(path) ?? path;
}
