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
  Plus,
  RefreshCw,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { useI18n } from '@/hooks/use-i18n';
import { resolveApiErrorMessage } from '@/lib/utils';
import { BranchControl } from './BranchControl';
import { CommitForm } from './CommitForm';
import { type DiffSelection, DiffViewer } from './DiffViewer';
import { useGitState, useInitRepo, useStagePaths, useUnstagePaths } from './hooks/use-git-state';
import { useGithubContext } from './hooks/use-github-context';
import { RemoteActions } from './RemoteActions';
import { RepositoryHistory } from './RepositoryHistory';
import { StashSection } from './StashSection';

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
  const isFetching = stateQuery.isFetching || githubQuery.isFetching;

  const refresh = async () => {
    const requests: Array<Promise<unknown>> = [stateQuery.refetch()];
    if (stateQuery.data?.state === 'repo') requests.push(githubQuery.refetch());
    await Promise.all(requests);
  };

  return (
    <section aria-label={labels.title} className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-outline-variant/15 px-4">
        <div className="min-w-0 flex-1 text-on-surface-variant">
          <RepositoryName state={stateQuery.data} />
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          aria-label={labels.refresh}
          title={labels.refresh}
          disabled={isFetching}
          className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-primary"
        >
          <RefreshCw size={15} className={isFetching ? 'animate-spin' : undefined} />
        </button>
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
  const [view, setView] = useState<'changes' | 'history'>('changes');
  const [diffSelection, setDiffSelection] = useState<DiffSelection | null>(null);
  const branchName = status.branch.name
    ? status.branch.name
    : labels.detachedAt.replace('{commit}', status.branch.detachedAt?.slice(0, 8) ?? 'HEAD');

  const mutatePaths = async (action: 'stage' | 'unstage', paths: string[]) => {
    try {
      if (action === 'stage') await stageMutation.mutateAsync({ paths });
      else await unstageMutation.mutateAsync({ paths });
    } catch (error) {
      toast(resolveApiErrorMessage(error, labels.actions.failed), 'error');
    }
  };

  return (
    <div className="space-y-5">
      <section aria-label={branchName} className="relative z-20">
        <BranchControl chatId={chatId} branch={status.branch} detachedLabel={branchName} />
        {status.branch.upstream ? (
          <p className="mt-1 truncate pl-6 font-mono text-[11px] text-on-surface-variant">
            {status.branch.upstream}
          </p>
        ) : null}
        <RemoteActions chatId={chatId} branch={status.branch} />
      </section>

      <GithubSection
        context={githubContext}
        loading={githubLoading}
        error={githubError}
        onRetry={onGithubRetry}
      />

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
              <ChangeGroup
                title={labels.groups.conflicted}
                changes={status.conflicted}
                action="stage"
                pending={stageMutation.isPending}
                onAction={(paths) => void mutatePaths('stage', paths)}
                onDiff={(path) =>
                  setDiffSelection({ path, title: labels.diff.view.replace('{path}', path) })
                }
              />
              <ChangeGroup
                title={labels.groups.staged}
                changes={status.staged}
                action="unstage"
                pending={unstageMutation.isPending}
                onAction={(paths) => void mutatePaths('unstage', paths)}
                onDiff={(path) =>
                  setDiffSelection({
                    path,
                    staged: true,
                    title: labels.diff.view.replace('{path}', path),
                  })
                }
              />
              <ChangeGroup
                title={labels.groups.unstaged}
                changes={status.unstaged}
                action="stage"
                pending={stageMutation.isPending}
                onAction={(paths) => void mutatePaths('stage', paths)}
                onDiff={(path) =>
                  setDiffSelection({ path, title: labels.diff.view.replace('{path}', path) })
                }
              />
              <ChangeGroup
                title={labels.groups.untracked}
                changes={status.untracked}
                action="stage"
                pending={stageMutation.isPending}
                onAction={(paths) => void mutatePaths('stage', paths)}
                onDiff={(path) =>
                  setDiffSelection({ path, title: labels.diff.view.replace('{path}', path) })
                }
              />
            </div>
          )}
          <CommitForm
            chatId={chatId}
            hasChanges={!status.clean}
            hasStagedChanges={status.staged.length > 0}
          />
          <StashSection chatId={chatId} />
        </>
      )}
    </div>
  );
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
  const [expanded, setExpanded] = useState(true);

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
  onDiff,
}: {
  readonly title: string;
  readonly changes: readonly GitFileChange[];
  readonly action: 'stage' | 'unstage';
  readonly pending: boolean;
  readonly onAction: (paths: string[]) => void;
  readonly onDiff: (path: string) => void;
}) {
  const { t } = useI18n();
  if (changes.length === 0) return null;
  const allLabel =
    action === 'stage'
      ? t.git.actions.stageAll.replace('{group}', title)
      : t.git.actions.unstageAll.replace('{group}', title);
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.12em] text-on-surface-variant">
        <span>{title}</span>
        <span className="rounded-full bg-surface-container-high px-1.5 py-0.5 font-mono text-[9px] tracking-normal">
          {changes.length}
        </span>
        <button
          type="button"
          aria-label={allLabel}
          title={allLabel}
          disabled={pending}
          onClick={() => onAction(changePaths(changes))}
          className="ml-auto cursor-pointer rounded px-1.5 py-0.5 text-[9px] tracking-normal text-primary transition-colors hover:bg-primary/10 disabled:cursor-wait disabled:opacity-50"
        >
          {action === 'stage' ? t.git.actions.stageAllButton : t.git.actions.unstageAllButton}
        </button>
      </h3>
      <ul className="overflow-hidden rounded-xl border border-outline-variant/15 bg-surface-container-lowest/40">
        {changes.map((change) => (
          <FileChangeRow
            key={`${change.status}:${change.oldPath ?? ''}:${change.path}`}
            change={change}
            action={action}
            pending={pending}
            onAction={() => onAction(changePaths([change]))}
            onDiff={() => onDiff(change.path)}
          />
        ))}
      </ul>
    </section>
  );
}

function FileChangeRow({
  change,
  action,
  pending,
  onAction,
  onDiff,
}: {
  readonly change: GitFileChange;
  readonly action: 'stage' | 'unstage';
  readonly pending: boolean;
  readonly onAction: () => void;
  readonly onDiff: () => void;
}) {
  const { t } = useI18n();
  const presentation = STATUS_PRESENTATION[change.status];
  const statusLabel = t.git.status[presentation.labelKey];
  const actionLabel = (action === 'stage' ? t.git.actions.stage : t.git.actions.unstage).replace(
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
        className="min-w-0 flex-1 cursor-pointer break-all text-left font-mono text-[11px] leading-4 text-on-surface hover:text-primary"
      >
        {change.oldPath ? (
          <>
            <span className="text-on-surface-variant line-through">{change.oldPath}</span>
            <span className="px-1 text-on-surface-variant">→</span>
          </>
        ) : null}
        {change.path}
      </button>
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
