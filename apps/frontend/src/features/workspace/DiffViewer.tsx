import { type GitDiffLine, parseGitDiff } from '@mangostudio/shared/git';
import { AlertTriangle, ArrowLeft, FileDiff, LoaderCircle } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/hooks/use-i18n';
import { useTheme } from '@/hooks/use-theme';
import { highlightLineTokens, preloadCodeLanguages } from '@/lib/shiki';
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
      className="overflow-hidden rounded-xl border border-outline-variant/15"
    >
      <div className="flex items-center gap-2 border-b border-outline-variant/15 bg-surface-container/60 px-2 py-2">
        <button
          type="button"
          onClick={onClose}
          aria-label={t.git.diff.back}
          className="flex size-7 cursor-pointer items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
        >
          <ArrowLeft size={14} />
        </button>
        <FileDiff size={14} className="shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[11px] font-semibold text-on-surface">
            {selection.path}
          </p>
          <p className="text-[9px] uppercase tracking-wider text-on-surface-variant">
            {selection.commit
              ? selection.commit.slice(0, 8)
              : selection.staged
                ? t.git.diff.staged
                : t.git.diff.worktree}
          </p>
        </div>
      </div>

      {query.isLoading ? (
        <DiffMessage icon={<LoaderCircle size={18} className="animate-spin" />}>
          {t.git.diff.loading}
        </DiffMessage>
      ) : query.error ? (
        <DiffMessage icon={<AlertTriangle size={18} />} tone="error">
          {t.git.diff.loadError}
        </DiffMessage>
      ) : query.data?.binary ? (
        <DiffMessage icon={<FileDiff size={18} />}>{t.git.diff.binary}</DiffMessage>
      ) : hunks.length === 0 ? (
        <DiffMessage icon={<FileDiff size={18} />}>{t.git.diff.empty}</DiffMessage>
      ) : (
        <div className="app-scrollbar max-h-[34rem] overflow-auto bg-surface-container-lowest font-mono text-[10px] leading-4">
          {hunks.map((hunk) => (
            <div key={`${hunk.oldStart}:${hunk.newStart}:${hunk.header}`}>
              <div className="sticky top-0 z-10 border-y border-primary/10 bg-primary/8 px-2 py-1 text-primary">
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
    addition: 'bg-success/10',
    deletion: 'bg-error/10',
    context: '',
    metadata: 'bg-surface-container text-on-surface-variant italic',
  }[line.type];
  const marker = line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' ';
  return (
    <div className={`flex min-w-max ${tone}`}>
      <span className="w-8 shrink-0 select-none border-r border-outline-variant/10 px-1 text-right text-on-surface-variant/50">
        {line.oldLine ?? ''}
      </span>
      <span className="w-8 shrink-0 select-none border-r border-outline-variant/10 px-1 text-right text-on-surface-variant/50">
        {line.newLine ?? ''}
      </span>
      <span className="w-5 shrink-0 select-none text-center text-on-surface-variant">{marker}</span>
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

function DiffMessage({
  icon,
  tone = 'neutral',
  children,
}: {
  readonly icon: React.ReactNode;
  readonly tone?: 'neutral' | 'error';
  readonly children: React.ReactNode;
}) {
  return (
    <div
      className={`flex min-h-32 flex-col items-center justify-center gap-2 px-4 text-center text-xs ${
        tone === 'error' ? 'text-error' : 'text-on-surface-variant'
      }`}
    >
      {icon}
      <p>{children}</p>
    </div>
  );
}

export type { DiffSelection };
