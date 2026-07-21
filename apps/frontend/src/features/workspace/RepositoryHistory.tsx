import type { GitCommitFile, GitCommitSummary } from '@mangostudio/shared/git';
import { ArrowLeft, FileCode2, GitCommitHorizontal, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import type { DiffSelection } from './DiffViewer';
import { useGitCommit, useGitHistory } from './hooks/use-git-state';

export function RepositoryHistory({
  chatId,
  onOpenDiff,
}: {
  readonly chatId: string;
  readonly onOpenDiff: (selection: DiffSelection) => void;
}) {
  const { t } = useI18n();
  const history = useGitHistory(chatId);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const details = useGitCommit(chatId, selectedHash);
  const commits = history.data?.pages.flatMap((page) => page.commits) ?? [];

  if (selectedHash) {
    return (
      <CommitDetails
        hash={selectedHash}
        loading={details.isLoading}
        commit={details.data?.commit}
        files={details.data?.files}
        onBack={() => setSelectedHash(null)}
        onOpenDiff={onOpenDiff}
      />
    );
  }

  if (history.isLoading) {
    return (
      <HistoryMessage
        icon={<LoaderCircle size={18} className="animate-spin" />}
        text={t.git.history.loading}
      />
    );
  }
  if (history.error) return <HistoryMessage text={t.git.history.loadError} tone="error" />;
  if (commits.length === 0) return <HistoryMessage text={t.git.history.empty} />;

  return (
    <div className="space-y-2">
      <ol className="overflow-hidden rounded-xl border border-outline-variant/15 bg-surface-container-lowest/40">
        {commits.map((commit) => (
          <li key={commit.hash} className="border-b border-outline-variant/10 last:border-b-0">
            <button
              type="button"
              onClick={() => setSelectedHash(commit.hash)}
              className="group w-full cursor-pointer px-3 py-2.5 text-left hover:bg-surface-container/60"
            >
              <div className="flex items-start gap-2">
                <GitCommitHorizontal size={13} className="mt-0.5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-on-surface">{commit.subject}</p>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-on-surface-variant">
                    <span className="font-mono text-primary/80">{commit.shortHash}</span>
                    <span className="truncate">{commit.author}</span>
                    <time className="ml-auto shrink-0" dateTime={commit.authoredAt}>
                      {formatCommitDate(commit.authoredAt)}
                    </time>
                  </div>
                  <CommitStats commit={commit} compact />
                </div>
              </div>
            </button>
          </li>
        ))}
      </ol>
      {history.hasNextPage ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-full"
          loading={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? t.git.history.loadingMore : t.git.history.loadMore}
        </Button>
      ) : null}
    </div>
  );
}

function CommitDetails({
  hash,
  loading,
  commit,
  files,
  onBack,
  onOpenDiff,
}: {
  readonly hash: string;
  readonly loading: boolean;
  readonly commit: GitCommitSummary | undefined;
  readonly files: readonly GitCommitFile[] | undefined;
  readonly onBack: () => void;
  readonly onOpenDiff: (selection: DiffSelection) => void;
}) {
  const { t } = useI18n();
  if (loading)
    return (
      <HistoryMessage
        icon={<LoaderCircle size={18} className="animate-spin" />}
        text={t.git.history.loading}
      />
    );
  if (!commit || !files) return <HistoryMessage text={t.git.history.loadError} tone="error" />;
  return (
    <section aria-label={t.git.history.commitDetails} className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] font-semibold text-primary"
      >
        <ArrowLeft size={13} />
        {t.git.history.back}
      </button>
      <div className="rounded-xl border border-outline-variant/15 bg-surface-container/35 p-3">
        <p className="text-sm font-semibold leading-5 text-on-surface">{commit.subject}</p>
        <p className="mt-1 text-[11px] text-on-surface-variant">
          {commit.author} · {formatCommitDate(commit.authoredAt)}
        </p>
        <p className="mt-2 font-mono text-[10px] text-primary">{commit.hash}</p>
        <CommitStats commit={commit} />
        {commit.refs.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {commit.refs.map((ref) => (
              <span
                key={ref}
                className="rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary"
              >
                {ref}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <ul className="overflow-hidden rounded-xl border border-outline-variant/15 bg-surface-container-lowest/40">
        {files.map((file) => (
          <li
            key={`${file.oldPath ?? ''}:${file.path}`}
            className="border-b border-outline-variant/10 last:border-b-0"
          >
            <button
              type="button"
              onClick={() =>
                onOpenDiff({
                  path: file.path,
                  commit: hash,
                  title: t.git.diff.view.replace('{path}', file.path),
                })
              }
              className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-2 text-left hover:bg-surface-container/60"
            >
              <FileCode2 size={13} className="shrink-0 text-on-surface-variant" />
              <span className="min-w-0 flex-1 truncate font-mono text-[10px]">{file.path}</span>
              <span className="shrink-0 font-mono text-[9px] text-success">
                +{file.additions ?? '—'}
              </span>
              <span className="shrink-0 font-mono text-[9px] text-error">
                -{file.deletions ?? '—'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CommitStats({
  commit,
  compact = false,
}: {
  readonly commit: GitCommitSummary;
  readonly compact?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className={`flex flex-wrap gap-x-2 font-mono text-[9px] ${compact ? 'mt-1' : 'mt-2'}`}>
      <span className="text-on-surface-variant">
        {t.git.history.filesChanged.replace('{count}', String(commit.changedFiles))}
      </span>
      <span className="text-success">
        {t.git.history.additions.replace('{count}', String(commit.additions))}
      </span>
      <span className="text-error">
        {t.git.history.deletions.replace('{count}', String(commit.deletions))}
      </span>
    </div>
  );
}

function HistoryMessage({
  icon,
  text,
  tone = 'neutral',
}: {
  readonly icon?: React.ReactNode;
  readonly text: string;
  readonly tone?: 'neutral' | 'error';
}) {
  return (
    <div
      className={`flex min-h-36 flex-col items-center justify-center gap-2 text-center text-xs ${tone === 'error' ? 'text-error' : 'text-on-surface-variant'}`}
    >
      {icon}
      <p>{text}</p>
    </div>
  );
}

function formatCommitDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(value)
  );
}
