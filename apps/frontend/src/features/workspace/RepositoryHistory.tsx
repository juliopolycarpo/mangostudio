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
import { usePlural } from '@/hooks/use-plural';
import { formatMessage } from '@/lib/i18n-format';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';
import { FilePathLabel } from './components/FilePathLabel';
import { RowList } from './components/RowList';
import type { DiffSelection } from './DiffViewer';
import { useGitCommit, useGitHistory } from './hooks/use-git-state';

/** U+2212, the typographic minus: a hyphen reads as a dash and is narrower than the plus beside it. */
const MINUS = '\u2212';

const numberFormatters = new Map<string, Intl.NumberFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * "10,826" in English, "10.826" in Portuguese: grouping is a locale rule, and
 * an ungrouped `10826` next to `10006` is a row of digits to count by eye.
 * Cached per locale, since a history page formats several numbers per commit.
 */
function formatCount(value: number, locale: string): string {
  const cached = numberFormatters.get(locale);
  const formatter = cached ?? new Intl.NumberFormat(locale);
  if (!cached) numberFormatters.set(locale, formatter);
  return formatter.format(value);
}

export function RepositoryHistory({
  chatId,
  onOpenDiff,
}: {
  readonly chatId: string;
  readonly onOpenDiff: (selection: DiffSelection) => void;
}) {
  const { t, locale } = useI18n();
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
                  {/* Two lines, not one: the subject is what this list is scanned for,
                      and a `refactor(frontend): ` prefix alone ate most of a truncated line. */}
                  <p
                    className="line-clamp-2 break-words text-sm font-medium text-fg"
                    title={commit.subject}
                  >
                    {commit.subject}
                  </p>
                  <div className="mt-1 flex items-center gap-2 text-xs text-fg-muted">
                    <span className="font-mono">{commit.shortHash}</span>
                    <span className="truncate">{commit.author}</span>
                    <time className="ml-auto shrink-0" dateTime={commit.authoredAt}>
                      {formatCommitDate(commit.authoredAt, locale)}
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
  const { t, locale } = useI18n();
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
          {commit.author} · {formatCommitDate(commit.authoredAt, locale)}
        </p>
        {/* The short hash is what anyone types or compares; the full one is a
            hover away, instead of a 40-character token wrapping mid-hash. */}
        <p className="mt-2 font-mono text-micro text-fg-subtle" title={commit.hash}>
          {commit.shortHash}
        </p>
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
              className="flex min-h-10 w-full cursor-pointer items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-fill-hover"
            >
              <FileCode2 size={ICON_SM} className="shrink-0 text-fg-muted" />
              {/* Stacked: the counts at the trailing edge leave a side-by-side
                  directory a few characters, so it gets a line of its own. */}
              <FilePathLabel stacked path={file.path} oldPath={file.oldPath} className="flex-1" />
              <FileCounts additions={file.additions} deletions={file.deletions} />
            </button>
          </li>
        ))}
      </RowList>
    </section>
  );
}

/** The commit's size as one scannable line: `352 files changed  +10,826  −10,006`. */
function CommitStats({
  commit,
  compact = false,
}: {
  readonly commit: GitCommitSummary;
  readonly compact?: boolean;
}) {
  const { t, locale } = useI18n();
  const plural = usePlural();
  const files = plural(
    { one: t.git.history.filesChangedOne, other: t.git.history.filesChangedOther },
    commit.changedFiles,
    { count: formatCount(commit.changedFiles, locale) }
  );
  const additions = formatCount(commit.additions, locale);
  const deletions = formatCount(commit.deletions, locale);
  return (
    <div className={cn('flex flex-wrap gap-x-2 font-mono text-micro', compact ? 'mt-1' : 'mt-2')}>
      <span className="text-fg-muted">{files}</span>
      {/* The sign is the cue that survives without colour; the words are for
          assistive tech, which would otherwise hear "plus 10,826 minus 10,006". */}
      <span className="text-success">
        <span aria-hidden="true">+{additions}</span>
        <span className="sr-only">
          {formatMessage(t.git.history.additionsLabel, { count: additions })}
        </span>
      </span>
      <span className="text-danger">
        <span aria-hidden="true">
          {MINUS}
          {deletions}
        </span>
        <span className="sr-only">
          {formatMessage(t.git.history.deletionsLabel, { count: deletions })}
        </span>
      </span>
    </div>
  );
}

/**
 * One file's line counts. A binary file has none to count (git reports `-`), so
 * it says so in a word rather than printing a pair of dashes that read as zero.
 */
function FileCounts({
  additions,
  deletions,
}: {
  readonly additions: number | null;
  readonly deletions: number | null;
}) {
  const { t, locale } = useI18n();
  if (additions === null || deletions === null) {
    return (
      <span className="shrink-0 font-mono text-micro text-fg-subtle">{t.git.history.binary}</span>
    );
  }
  return (
    <>
      <span className="shrink-0 font-mono text-micro text-success">
        +{formatCount(additions, locale)}
      </span>
      <span className="shrink-0 font-mono text-micro text-danger">
        {MINUS}
        {formatCount(deletions, locale)}
      </span>
    </>
  );
}

/** "Aug 12" in English, "12 de ago." in Portuguese: the day order and month name are the locale's, not the browser's. */
function formatCommitDate(value: string, locale: string): string {
  const cached = dateFormatters.get(locale);
  const formatter = cached ?? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
  if (!cached) dateFormatters.set(locale, formatter);
  return formatter.format(new Date(value));
}
