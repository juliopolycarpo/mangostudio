import { type GitDiffLine, parseGitDiff } from '@mangostudio/shared/git';
import { FileDiff } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';

import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';
import { useTheme } from '@/hooks/use-theme';
import type { CodeThemeId } from '@/lib/code-themes';
import { retryStoppedHighlights } from '@/lib/highlight-retry';
import { ICON_LG } from '@/lib/icon-sizes';
import {
  highlightLineTokens,
  isLineHighlightRetryPending,
  preloadCodeLanguages,
} from '@/lib/shiki';
import { cn } from '@/lib/utils';

import type { GitDiffInput } from './hooks/use-git-state';
import { useGitDiff } from './hooks/use-git-state';

/**
 * How much of a syntax colour survives on an added or removed line; the rest is
 * the foreground. Shiki's palettes are tuned for their own backgrounds, and a
 * keyword or comment colour over the app's success/danger fill fell to 2.4:1 to
 * 3.8:1. At half, the worst token of all four code themes clears 4.5:1 on both
 * fills and still keeps its hue. Context lines sit on the canvas, so they keep
 * the theme's colours untouched.
 */
const TINTED_TOKEN_SHARE = '50%';

/**
 * The code box scrolls sideways, and in a 280px rail it cuts a line at about 25
 * characters. `app-scrollbar` draws a 4px thumb on a transparent track, which the
 * platform's overlay scrollbar (macOS, Android, an emulated phone) hides the
 * moment nobody is scrolling, so nothing said the lines continue. This is the
 * treatment of `.markdown-table-scroll` (`styles/markdown-content.css`): a styled
 * `::-webkit-scrollbar`, the one kind those engines draw at rest, with a track so
 * the bar's extent shows, and the standard properties where the engine has no
 * such pseudo (Firefox). It deliberately does not carry `app-scrollbar`: that
 * class sets `scrollbar-width`, which makes Chromium ignore the pseudo-elements.
 */
const DIFF_SCROLL_CLASS = [
  'overflow-auto',
  '[&::-webkit-scrollbar]:size-1.5',
  '[&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-fill-selected',
  '[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-stroke-strong',
  'hover:[&::-webkit-scrollbar-thumb]:bg-fg-muted',
  'supports-[not(selector(::-webkit-scrollbar))]:[scrollbar-width:thin]',
  'supports-[not(selector(::-webkit-scrollbar))]:[scrollbar-color:var(--color-stroke-strong)_var(--color-fill-selected)]',
].join(' ');

interface DiffSelection extends GitDiffInput {
  readonly title: string;
}

export function DiffViewer({
  chatId,
  selection,
}: {
  readonly chatId: string;
  readonly selection: DiffSelection;
}) {
  const { t } = useI18n();
  const { resolvedCodeTheme } = useTheme();
  const query = useGitDiff(chatId, selection);
  const language = inferLanguage(selection.path);
  // What the highlighter has actually loaded: the grammar and the theme the rows
  // may colour with. A newly chosen theme leaves the previous one in place until
  // its chunk arrives, so rows keep their colours instead of each throwing
  // "theme not found" and going plain. Another file's grammar is not this one's:
  // the rows ask for it only while `loaded.language` matches.
  const [loaded, setLoaded] = useState<{
    readonly language: string;
    readonly theme: CodeThemeId;
  } | null>(null);
  const rowLanguage = loaded?.language === language ? language : null;
  const hunks = useMemo(() => parseGitDiff(query.data?.diff ?? ''), [query.data?.diff]);

  useEffect(() => {
    let active = true;
    if (!language) return;
    void preloadCodeLanguages([language], resolvedCodeTheme).then(
      () => {
        if (active) setLoaded({ language, theme: resolvedCodeTheme });
      },
      () => {
        // Plain source and line chrome remain usable after a failed language load.
      }
    );
    return () => {
      active = false;
    };
  }, [language, resolvedCodeTheme]);

  // The titled region and the back control are `DiffViewerFrame`'s, drawn by
  // `LazyDiffViewer` before this chunk loads; this is only what goes inside it.
  return (
    <>
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
        <div
          className={cn('@container max-h-[34rem] bg-canvas font-mono text-xs', DIFF_SCROLL_CLASS)}
        >
          {hunks.map((hunk) => (
            <div key={`${hunk.oldStart}:${hunk.newStart}:${hunk.header}`}>
              <div
                title={hunk.header}
                className="sticky top-0 z-10 truncate border-y border-stroke bg-surface px-2 py-1 text-fg-muted"
              >
                {hunk.header}
              </div>
              {hunk.lines.map((line, index) => (
                <DiffLineRow
                  key={diffLineKey(hunk.lines, index)}
                  line={line}
                  language={rowLanguage}
                  theme={loaded?.theme ?? resolvedCodeTheme}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </>
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
  // `retries` counts the times a stopped line was asked for again; each one reads the line anew.
  const [retries, setRetries] = useState(0);
  const highlighted = useMemo(
    () => (language ? highlightLineTokens(line.content || ' ', language, theme) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `retries` only forces a new read.
    [line.content, language, theme, retries]
  );
  // A line the tokenizer stopped on its time limit is asked for once more after yielding: the
  // first line of a cold grammar pays the rule compile, and later lines tokenize in milliseconds.
  useEffect(() => {
    if (highlighted || !language) return;
    const text = line.content || ' ';
    if (!isLineHighlightRetryPending(text, language, theme)) return;
    return retryStoppedHighlights([() => highlightLineTokens(text, language, theme) !== null], () =>
      setRetries((count) => count + 1)
    );
  }, [highlighted, line.content, language, theme]);
  const tone = {
    addition: 'bg-success-subtle',
    deletion: 'bg-danger-subtle',
    context: '',
    metadata: 'text-fg-muted italic',
  }[line.type];
  // The gutter marker is what says added or removed; the fill only backs it up.
  const marker = line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' ';
  const tinted = line.type === 'addition' || line.type === 'deletion';
  const markerTone =
    line.type === 'addition' ? 'text-success' : line.type === 'deletion' ? 'text-danger' : '';
  // In a narrow rail two 40px gutters leave the code about 24 characters, so
  // the viewer keeps one: the new number, or the old one on a line that has no
  // new number (a deletion). Both stay in the markup; the container query only
  // decides which of the two is drawn, so the wide layout is untouched.
  const hasNewLine = line.newLine !== undefined;
  return (
    <div className={cn('flex min-w-max', tone)}>
      <span
        className={cn(
          'w-10 shrink-0 select-none border-r border-stroke px-1 text-right text-fg-subtle',
          hasNewLine && '@max-sm:hidden'
        )}
      >
        {line.oldLine ?? ''}
      </span>
      <span
        className={cn(
          'w-10 shrink-0 select-none border-r border-stroke px-1 text-right text-fg-subtle',
          !hasNewLine && '@max-sm:hidden'
        )}
      >
        {line.newLine ?? ''}
      </span>
      <span className={cn('w-5 shrink-0 select-none text-center font-medium', markerTone)}>
        {marker}
      </span>
      {highlighted ? (
        <code className="min-w-0 whitespace-pre pr-3">
          {highlighted.map((token) => (
            <span key={token.offset} style={{ color: tokenColor(token.color, tinted) }}>
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

/**
 * A row's key: its numbers and content, which are unique within a hunk for every
 * line that has a number. A `\ No newline at end of file` marker has none, and
 * a hunk where both sides lack the final newline carries two identical ones, so
 * a marker is keyed by the line it annotates.
 */
function diffLineKey(lines: readonly GitDiffLine[], index: number): string {
  const line = lines[index];
  if (!line) return String(index);
  if (line.type === 'metadata' && index > 0) return `${diffLineKey(lines, index - 1)}:meta`;
  return `${line.type}:${line.oldLine ?? ''}:${line.newLine ?? ''}:${line.content}`;
}

function tokenColor(color: string | undefined, tinted: boolean): string | undefined {
  if (!color || !tinted) return color;
  return `color-mix(in srgb, ${color} ${TINTED_TOKEN_SHARE}, var(--color-fg))`;
}

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
        diff: 'diff',
        go: 'go',
        htm: 'html',
        html: 'html',
        java: 'java',
        js: 'javascript',
        json: 'json',
        jsonc: 'json',
        jsx: 'jsx',
        md: 'markdown',
        php: 'php',
        ps1: 'powershell',
        py: 'python',
        rb: 'ruby',
        rs: 'rust',
        sh: 'bash',
        sql: 'sql',
        svelte: 'svelte',
        swift: 'swift',
        ts: 'typescript',
        tsx: 'tsx',
        vue: 'vue',
        xml: 'xml',
        yaml: 'yaml',
        yml: 'yaml',
      } as const
    )[extension ?? ''] ?? null
  );
}

export type { DiffSelection };
