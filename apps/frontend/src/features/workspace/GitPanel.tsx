import type {
  GitFileChange,
  GitFileStatus,
  GitRepoState,
  GitStatus,
} from '@mangostudio/shared/git';
import type { Messages } from '@mangostudio/shared/i18n';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  FileCode2,
  FolderGit2,
  GitBranch,
  RefreshCw,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { useGitState, useInitRepo } from './hooks/use-git-state';

interface GitPanelProps {
  readonly chatId: string;
}

const STATUS_GLYPHS: Readonly<Record<GitFileStatus, string>> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: '?',
  conflicted: '!',
  'type-changed': 'T',
};

const STATUS_LABEL_KEYS: Readonly<Record<GitFileStatus, keyof Messages['git']['status']>> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  untracked: 'untracked',
  conflicted: 'conflicted',
  'type-changed': 'typeChanged',
};

const STATUS_COLORS: Readonly<Record<GitFileStatus, string>> = {
  modified: 'text-warning',
  added: 'text-success',
  deleted: 'text-error',
  renamed: 'text-primary',
  copied: 'text-primary',
  untracked: 'text-on-surface-variant',
  conflicted: 'text-error',
  'type-changed': 'text-warning',
};

export function GitPanel({ chatId }: GitPanelProps) {
  const { t } = useI18n();
  const labels = t.git;
  const [expanded, setExpanded] = useState(true);
  const stateQuery = useGitState(chatId);
  const initMutation = useInitRepo(chatId);

  if (!expanded) {
    return (
      <aside
        aria-label={labels.title}
        className="hidden h-full w-12 shrink-0 flex-col items-center border-l border-outline-variant/15 bg-surface-container-low lg:flex"
      >
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={labels.expand}
          className="flex h-14 w-full cursor-pointer items-center justify-center text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary"
        >
          <FolderGit2 size={18} />
        </button>
      </aside>
    );
  }

  return (
    <aside
      aria-label={labels.title}
      className="hidden h-full w-80 shrink-0 flex-col border-l border-outline-variant/15 bg-surface-container-low lg:flex"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-outline-variant/15 px-4">
        <FolderGit2 size={18} className="shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-bold text-on-surface">{labels.title}</h2>
          <RepositoryName state={stateQuery.data} />
        </div>
        <button
          type="button"
          onClick={() => void stateQuery.refetch()}
          aria-label={labels.refresh}
          title={labels.refresh}
          disabled={stateQuery.isFetching}
          className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-primary"
        >
          <RefreshCw size={15} className={stateQuery.isFetching ? 'animate-spin' : undefined} />
        </button>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-label={labels.collapse}
          title={labels.collapse}
          className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
        >
          <ChevronRight size={16} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4" aria-live="polite">
        <GitPanelContent
          state={stateQuery.data}
          loading={stateQuery.isLoading}
          error={stateQuery.error}
          initPending={initMutation.isPending}
          initError={initMutation.error}
          onInitialize={() => initMutation.mutate()}
          onRetry={() => void stateQuery.refetch()}
        />
      </div>
    </aside>
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
  readonly state: GitRepoState | undefined;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly initPending: boolean;
  readonly initError: Error | null;
  readonly onInitialize: () => void;
  readonly onRetry: () => void;
}

function GitPanelContent({
  state,
  loading,
  error,
  initPending,
  initError,
  onInitialize,
  onRetry,
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
      return <RepositoryStatus status={state.status} />;
  }
}

function RepositoryStatus({ status }: { readonly status: GitStatus }) {
  const { t } = useI18n();
  const labels = t.git;
  const branchName = status.branch.name
    ? status.branch.name
    : labels.detachedAt.replace('{commit}', status.branch.detachedAt?.slice(0, 8) ?? 'HEAD');

  return (
    <div className="space-y-5">
      <section aria-label={branchName}>
        <div className="flex items-center gap-2">
          <GitBranch size={15} className="shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs font-semibold text-on-surface">
            {branchName}
          </span>
        </div>
        {status.branch.upstream ? (
          <p className="mt-1 truncate pl-6 font-mono text-[11px] text-on-surface-variant">
            {status.branch.upstream}
          </p>
        ) : null}
        {status.branch.ahead > 0 || status.branch.behind > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
            {status.branch.ahead > 0 ? (
              <DivergenceBadge icon={<ArrowUp size={11} />}>
                {labels.ahead.replace('{count}', String(status.branch.ahead))}
              </DivergenceBadge>
            ) : null}
            {status.branch.behind > 0 ? (
              <DivergenceBadge icon={<ArrowDown size={11} />}>
                {labels.behind.replace('{count}', String(status.branch.behind))}
              </DivergenceBadge>
            ) : null}
          </div>
        ) : null}
      </section>

      {status.clean ? (
        <PanelMessage
          icon={<Check size={22} />}
          title={labels.cleanTitle}
          detail={labels.cleanHint}
          tone="success"
        />
      ) : (
        <div className="space-y-4">
          <ChangeGroup title={labels.groups.conflicted} changes={status.conflicted} />
          <ChangeGroup title={labels.groups.staged} changes={status.staged} />
          <ChangeGroup title={labels.groups.unstaged} changes={status.unstaged} />
          <ChangeGroup title={labels.groups.untracked} changes={status.untracked} />
        </div>
      )}
    </div>
  );
}

function DivergenceBadge({
  icon,
  children,
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-container-high px-2 py-1 text-[10px] font-semibold text-on-surface-variant">
      {icon}
      {children}
    </span>
  );
}

function ChangeGroup({
  title,
  changes,
}: {
  readonly title: string;
  readonly changes: readonly GitFileChange[];
}) {
  if (changes.length === 0) return null;
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.12em] text-on-surface-variant">
        <span>{title}</span>
        <span className="rounded-full bg-surface-container-high px-1.5 py-0.5 font-mono text-[9px] tracking-normal">
          {changes.length}
        </span>
      </h3>
      <ul className="overflow-hidden rounded-xl border border-outline-variant/15 bg-surface-container-lowest/40">
        {changes.map((change) => (
          <FileChangeRow
            key={`${change.status}:${change.oldPath ?? ''}:${change.path}`}
            change={change}
          />
        ))}
      </ul>
    </section>
  );
}

function FileChangeRow({ change }: { readonly change: GitFileChange }) {
  const { t } = useI18n();
  const statusLabel = t.git.status[STATUS_LABEL_KEYS[change.status]];
  return (
    <li className="flex min-w-0 items-start gap-2 border-b border-outline-variant/10 px-2.5 py-2 last:border-b-0">
      <span
        className={`w-3 shrink-0 pt-px text-center font-mono text-[11px] font-bold ${STATUS_COLORS[change.status]}`}
        title={statusLabel}
        aria-hidden="true"
      >
        {STATUS_GLYPHS[change.status]}
      </span>
      <span className="sr-only">{statusLabel}</span>
      <FileCode2 size={13} className="mt-0.5 shrink-0 text-on-surface-variant/70" />
      <span className="min-w-0 flex-1 break-all font-mono text-[11px] leading-4 text-on-surface">
        {change.oldPath ? (
          <>
            <span className="text-on-surface-variant line-through">{change.oldPath}</span>
            <span className="px-1 text-on-surface-variant">→</span>
          </>
        ) : null}
        {change.path}
      </span>
    </li>
  );
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
