import type { GitCommitFile, GitCommitSummary } from '@mangostudio/shared/git';
import { ArrowLeft, FileCode2, GitCommitHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { RowList } from './components/RowList';
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
    return <EmptyState icon={<Spinner />} title={t.git.history.loading} className="min-h-36" />;
  }
  if (history.error) return <Callout tone="danger" title={t.git.history.loadError} />;
  if (commits.length === 0) return <EmptyState title={t.git.history.empty} className="min-h-36" />;

  return (
    <div className="space-y-2">
      <RowList as="ol">
        {commits.map((commit) => (
          <li key={commit.hash}>
            <button
              type="button"
              onClick={() => setSelectedHash(commit.hash)}
              className="w-full cursor-pointer px-3 py-2 text-left transition-colors hover:bg-fill-hover"
            >
              <div className="flex items-start gap-2">
                <GitCommitHorizontal size={ICON_SM} className="mt-0.5 shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{commit.subject}</p>
                  <div className="mt-1 flex items-center gap-2 text-xs text-fg-muted">
                    <span className="font-mono">{commit.shortHash}</span>
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
      </RowList>
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
  if (loading) {
    return <EmptyState icon={<Spinner />} title={t.git.history.loading} className="min-h-36" />;
  }
  if (!commit || !files) return <Callout tone="danger" title={t.git.history.loadError} />;
  return (
    <section aria-label={t.git.history.commitDetails} className="space-y-3">
      <Button type="button" variant="subtle" size="sm" onClick={onBack} className="-ml-2">
        <ArrowLeft size={ICON_SM} />
        {t.git.history.back}
      </Button>
      <Card padded={false} className="p-3">
        <p className="text-sm font-semibold text-fg">{commit.subject}</p>
        <p className="mt-1 text-xs text-fg-muted">
          {commit.author} · {formatCommitDate(commit.authoredAt)}
        </p>
        <p className="mt-2 break-all font-mono text-micro text-fg-subtle">{commit.hash}</p>
        <CommitStats commit={commit} />
        {commit.refs.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {commit.refs.map((ref) => (
              <Chip key={ref}>{ref}</Chip>
            ))}
          </div>
        ) : null}
      </Card>
      <RowList>
        {files.map((file) => (
          <li key={`${file.oldPath ?? ''}:${file.path}`}>
            <button
              type="button"
              onClick={() =>
                onOpenDiff({
                  path: file.path,
                  commit: hash,
                  title: t.git.diff.view.replace('{path}', file.path),
                })
              }
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-fill-hover"
            >
              <FileCode2 size={ICON_SM} className="shrink-0 text-fg-muted" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{file.path}</span>
              <span className="shrink-0 font-mono text-micro text-success">
                +{file.additions ?? '—'}
              </span>
              <span className="shrink-0 font-mono text-micro text-danger">
                -{file.deletions ?? '—'}
              </span>
            </button>
          </li>
        ))}
      </RowList>
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
    <div className={`flex flex-wrap gap-x-2 font-mono text-micro ${compact ? 'mt-1' : 'mt-2'}`}>
      <span className="text-fg-muted">
        {t.git.history.filesChanged.replace('{count}', String(commit.changedFiles))}
      </span>
      <span className="text-success">
        {t.git.history.additions.replace('{count}', String(commit.additions))}
      </span>
      <span className="text-danger">
        {t.git.history.deletions.replace('{count}', String(commit.deletions))}
      </span>
    </div>
  );
}

function formatCommitDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(value)
  );
}
