import { type GitDiffLine, parseGitDiff } from '@mangostudio/shared/git';
import { ArrowLeft, FileDiff } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';
import { useTheme } from '@/hooks/use-theme';
import { ICON_LG, ICON_SM } from '@/lib/icon-sizes';
import { highlightLineTokens, preloadCodeLanguages } from '@/lib/shiki';
import { cn } from '@/lib/utils';
import { IconButton } from './components/IconButton';
import type { GitDiffInput } from './hooks/use-git-state';
import { useGitDiff } from './hooks/use-git-state';

interface DiffSelection extends GitDiffInput {
  readonly title: string;
}

export function DiffViewer({
  chatId,
  selection,
  onClose,
}: {
  readonly chatId: string;
  readonly selection: DiffSelection;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const { resolvedCodeTheme } = useTheme();
  const query = useGitDiff(chatId, selection);
  const language = inferLanguage(selection.path);
  const [highlightReady, setHighlightReady] = useState(false);
  const hunks = useMemo(() => parseGitDiff(query.data?.diff ?? ''), [query.data?.diff]);

  useEffect(() => {
    let active = true;
    setHighlightReady(false);
    if (!language) return;
    void preloadCodeLanguages([language]).then(() => {
      if (active) setHighlightReady(true);
    });
    return () => {
      active = false;
    };
  }, [language]);

  return (
    <section
      aria-label={selection.title}
      className="overflow-hidden rounded-md border border-stroke bg-surface"
    >
      <div className="flex h-10 items-center gap-2 border-b border-stroke px-2">
        <IconButton label={t.git.diff.back} onClick={onClose}>
          <ArrowLeft size={ICON_SM} />
        </IconButton>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs font-medium text-fg">{selection.path}</p>
          <p className={cn('text-micro text-fg-subtle', selection.commit && 'font-mono')}>
            {selection.commit
              ? selection.commit.slice(0, 8)
              : selection.staged
                ? t.git.diff.staged
                : t.git.diff.worktree}
          </p>
        </div>
      </div>

      {query.isLoading ? (
        <EmptyState icon={<Spinner />} title={t.git.diff.loading} className="min-h-32" />
      ) : query.error ? (
        <div className="p-3">
          <Callout tone="danger" title={t.git.diff.loadError} />
        </div>
      ) : query.data?.binary ? (
        <EmptyState
          icon={<FileDiff size={ICON_LG} />}
          title={t.git.diff.binary}
          className="min-h-32"
        />
      ) : hunks.length === 0 ? (
        <EmptyState
          icon={<FileDiff size={ICON_LG} />}
          title={t.git.diff.empty}
          className="min-h-32"
        />
      ) : (
        <div className="app-scrollbar max-h-[34rem] overflow-auto bg-canvas font-mono text-xs">
          {hunks.map((hunk) => (
            <div key={`${hunk.oldStart}:${hunk.newStart}:${hunk.header}`}>
              <div className="sticky top-0 z-10 border-y border-stroke bg-surface px-2 py-1 text-fg-muted">
                {hunk.header}
              </div>
              {hunk.lines.map((line) => (
                <DiffLineRow
                  key={`${line.type}:${line.oldLine ?? ''}:${line.newLine ?? ''}:${line.content}`}
                  line={line}
                  language={highlightReady ? language : null}
                  theme={resolvedCodeTheme}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const DiffLineRow = memo(function DiffLineRow({
  line,
  language,
  theme,
}: {
  readonly line: GitDiffLine;
  readonly language: string | null;
  readonly theme: Parameters<typeof highlightLineTokens>[2];
}) {
  // Tokenizing is synchronous Shiki work per line; a large diff re-runs it for
  // every row on any parent re-render without this.
  const highlighted = useMemo(
    () => (language ? highlightLineTokens(line.content || ' ', language, theme) : null),
    [line.content, language, theme]
  );
  const tone = {
    addition: 'bg-success-subtle',
    deletion: 'bg-danger-subtle',
    context: '',
    metadata: 'text-fg-muted italic',
  }[line.type];
  // The gutter marker is what says added or removed; the fill only backs it up.
  const marker = line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' ';
  const markerTone =
    line.type === 'addition' ? 'text-success' : line.type === 'deletion' ? 'text-danger' : '';
  return (
    <div className={cn('flex min-w-max', tone)}>
      <span className="w-10 shrink-0 select-none border-r border-stroke px-1 text-right text-fg-subtle">
        {line.oldLine ?? ''}
      </span>
      <span className="w-10 shrink-0 select-none border-r border-stroke px-1 text-right text-fg-subtle">
        {line.newLine ?? ''}
      </span>
      <span className={cn('w-5 shrink-0 select-none text-center font-medium', markerTone)}>
        {marker}
      </span>
      {highlighted ? (
        <code className="min-w-0 whitespace-pre pr-3">
          {highlighted.map((token) => (
            <span key={token.offset} style={{ color: token.color }}>
              {token.content}
            </span>
          ))}
        </code>
      ) : (
        <code className="min-w-0 whitespace-pre pr-3">{line.content || ' '}</code>
      )}
    </div>
  );
});

function inferLanguage(path: string): string | null {
  const extension = path.split('.').at(-1)?.toLowerCase();
  return (
    (
      {
        bash: 'bash',
        c: 'c',
        cpp: 'cpp',
        cs: 'csharp',
        css: 'css',
        go: 'go',
        htm: 'html',
        html: 'html',
        java: 'java',
        js: 'javascript',
        json: 'json',
        jsx: 'jsx',
        md: 'markdown',
        php: 'php',
        ps1: 'powershell',
        py: 'python',
        rb: 'ruby',
        rs: 'rust',
        sh: 'bash',
        sql: 'sql',
        swift: 'swift',
        ts: 'typescript',
        tsx: 'tsx',
        xml: 'xml',
        yaml: 'yaml',
        yml: 'yaml',
      } as const
    )[extension ?? ''] ?? null
  );
}

export type { DiffSelection };
