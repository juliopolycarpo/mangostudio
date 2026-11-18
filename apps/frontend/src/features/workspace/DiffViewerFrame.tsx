import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';

import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

import { FilePathLabel } from './components/FilePathLabel';
import { IconButton } from './components/IconButton';
import type { DiffSelection } from './DiffViewer';
import { shortHash } from './short-hash';

/**
 * The diff viewer's chrome: the titled region, the back control and the file
 * header, around whatever body the caller draws.
 *
 * It lives outside the lazy chunk on purpose. `LazyDiffViewer` mounts it before
 * the viewer's own chunk arrives, so a slow or failed fetch still leaves the way
 * back on screen instead of a bare spinner or failure panel with no exit.
 *
 * @example
 * <DiffViewerFrame selection={selection} onClose={close}><Body /></DiffViewerFrame>
 */
export function DiffViewerFrame({
  selection,
  onClose,
  children,
}: {
  readonly selection: DiffSelection;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const { t } = useI18n();

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
          <FilePathLabel path={selection.path} />
          <p
            className={cn('text-micro text-fg-subtle', selection.commit && 'font-mono')}
            title={selection.commit}
          >
            {selection.commit
              ? shortHash(selection.commit)
              : selection.staged
                ? t.git.diff.staged
                : t.git.diff.worktree}
          </p>
        </div>
      </div>
      {children}
    </section>
  );
}
