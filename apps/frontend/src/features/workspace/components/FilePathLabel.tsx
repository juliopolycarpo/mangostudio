import { cn } from '@/lib/utils';

interface FilePathLabelProps {
  /** Repository-relative, always `/`-separated: the form git reports. */
  readonly path: string;
  /** Where a rename or move came from, when the entry is one. */
  readonly oldPath?: string | null;
  /**
   * The name on one line and its directory on the line below, instead of side by
   * side. For a row that also carries counts or badges at its trailing edge: in a
   * 311px dock a long name plus `+10,826 −10,006` leaves the side-by-side
   * directory a few characters, which reads as noise (`a…`) and fails at the one
   * job a directory has, telling two `index.html` apart.
   */
  readonly stacked?: boolean;
  readonly className?: string;
}

interface SplitPath {
  readonly dir: string;
  readonly name: string;
}

/**
 * Splits at the last `/`. A trailing slash (git reports an untracked directory
 * as `dir/`) stays on the name, so the directory does not come out empty.
 */
function splitPath(path: string): SplitPath {
  const body = path.endsWith('/') ? path.slice(0, -1) : path;
  const cut = body.lastIndexOf('/');
  const suffix = body === path ? '' : '/';
  return cut === -1
    ? { dir: '', name: `${body}${suffix}` }
    : { dir: body.slice(0, cut), name: `${body.slice(cut + 1)}${suffix}` };
}

/**
 * A file path laid out for a narrow row: the file name first in `fg`, its
 * directory after it in `fg-subtle`. Only the directory gives way when the row
 * is short, so the one segment that tells two files apart is never the part cut
 * off — a plain `truncate` on the whole path hid exactly that and left a column
 * of rows that all began `apps/frontend/src/compo…`. The full path is the
 * tooltip.
 *
 * The directory is cut from the left, not the right: in a list every path shares
 * its first segments (`apps/frontend/…`), so a right-hand cut leaves a column of
 * identical prefixes, while the segment nearest the file is the one that differs.
 * That is `dir="rtl"` on the clipping span, which moves the ellipsis to the left
 * edge, with the text inside an isolated LTR `<bdi>` — a bare RTL run would
 * reorder neutral characters, so `.github/workflows` would read
 * `github/workflows.`.
 *
 * A rename shows what changed: a different name is `old → new`, and a pure move
 * (same name) is `old dir → new dir`, each struck through on the old side.
 *
 * Mono, because a path is technical content (`foundations.md`, Typography). The
 * caller sizes the cell with `className` (`flex-1` in a row of siblings).
 *
 * `stacked` gives the directory its own line (see {@link FilePathLabelProps}).
 * A rename then reads the new name on top and the old name struck through
 * underneath, a pure move the old directory struck through and then the new one.
 *
 * @example
 * <FilePathLabel path="apps/frontend/src/features/workspace/GitPanel.tsx" className="flex-1" />
 */
export function FilePathLabel({ path, oldPath, stacked = false, className }: FilePathLabelProps) {
  const to = splitPath(path);
  const from = oldPath ? splitPath(oldPath) : null;
  const moved = from !== null && from.name === to.name;

  if (stacked) {
    const detail = moved ? (
      <>
        <span className="line-through">{from.dir || '.'}</span> → {to.dir || '.'}
      </>
    ) : from ? (
      <>
        <span className="line-through">{from.name}</span>
        {to.dir ? ` · ${to.dir}` : null}
      </>
    ) : (
      to.dir
    );
    return (
      <span
        title={oldPath ? `${oldPath} → ${path}` : path}
        className={cn('flex min-w-0 flex-col font-mono text-xs', className)}
      >
        <span className="sr-only">{oldPath ? `${oldPath} → ${path}` : path}</span>
        <span aria-hidden="true" className="truncate text-fg">
          {to.name}
        </span>
        {detail ? (
          <span aria-hidden="true" className="truncate text-micro text-fg-subtle">
            {detail}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span
      title={oldPath ? `${oldPath} → ${path}` : path}
      className={cn('flex min-w-0 items-baseline font-mono text-xs', className)}
    >
      {/* The two halves are a layout trick, so assistive tech gets the path whole
          rather than "git.ts" and "src" as two unrelated words. */}
      <span className="sr-only">{oldPath ? `${oldPath} → ${path}` : path}</span>
      <span aria-hidden="true" className="flex min-w-0 flex-1 items-baseline gap-2">
        {from && !moved ? (
          <>
            <span className="max-w-full shrink-0 truncate text-fg-muted line-through">
              {from.name}
            </span>
            <span className="shrink-0 text-fg-muted">→</span>
          </>
        ) : null}
        <span className="max-w-full shrink-0 truncate text-fg">{to.name}</span>
        {moved ? (
          <span dir="rtl" className="min-w-0 truncate text-left text-fg-subtle">
            <bdi dir="ltr">
              <span className="line-through">{from.dir || '.'}</span>
              <span> → </span>
              {to.dir || '.'}
            </bdi>
          </span>
        ) : to.dir ? (
          <span dir="rtl" className="min-w-0 truncate text-left text-fg-subtle">
            <bdi dir="ltr">{to.dir}</bdi>
          </span>
        ) : null}
      </span>
    </span>
  );
}
