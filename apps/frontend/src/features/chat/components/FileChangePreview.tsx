import { ArrowRight } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

import {
  DIFF_PREVIEW_MAX_LINES,
  type DiffPreviewLine,
  type FileChangeFilePreview,
  type FileChangePreview,
  truncateDiffLines,
} from './file-change-preview';
import { abbreviatePath } from './ToolCallVisuals';

interface FileChangePreviewBodyProps {
  preview: FileChangePreview;
  /**
   * A control for the card as a whole (the raw-arguments toggle), set at the
   * right end of the first file's header rather than in a band of its own above
   * it.
   */
  action?: ReactNode;
}

/**
 * A diff line's own columns. The gutter starts at the header's 12px inset, so
 * the `+`/`-` sits under the badge rather than at the panel's edge.
 */
const GUTTER_CELL_CLASS = 'w-7 select-none pr-1.5 pl-3 text-left';

/**
 * What each operation reads as. Status colours are for outcomes that matter:
 * a new file is a success, an overwrite replaces content the preview cannot
 * show (attention), a delete is destructive. An edit or a move is the ordinary
 * case and stays neutral — the accent is not a status.
 */
const OP_VARIANTS: Record<FileChangeFilePreview['op'], ComponentProps<typeof Badge>['variant']> = {
  create: 'success',
  overwrite: 'warning',
  update: 'neutral',
  delete: 'error',
  move: 'neutral',
};

const LINE_STYLES: Record<DiffPreviewLine['kind'], { row: string; gutter: string }> = {
  add: { row: 'bg-success-subtle text-success', gutter: '+' },
  del: { row: 'bg-danger-subtle text-danger', gutter: '-' },
  context: { row: 'text-fg-muted', gutter: ' ' },
  marker: { row: 'text-fg-subtle', gutter: ' ' },
};

/**
 * Renders a computed file-change preview: one section per touched file with an
 * operation badge, +/- counts, and a capped, color-coded diff body.
 *
 * Drawn the way a tool's other output is (`ToolOutputSection`): a 32px header on
 * the card, then the lines as a full-bleed band of `canvas` divided by a
 * hairline. A framed, inset diff box inside the tool block's own frame was a
 * second treatment for the same thing, and a frame inside a frame.
 *
 * // Usage: <FileChangePreviewBody preview={preview} action={<Button size="sm">Raw</Button>} />
 */
export function FileChangePreviewBody({ preview, action }: FileChangePreviewBodyProps) {
  const { t } = useI18n();
  const d = t.tools.diff;
  // The render budget is shared across files so a many-file patch cannot
  // multiply it away.
  let remainingLines = DIFF_PREVIEW_MAX_LINES;

  const hasRepeatLine = preview.repeatCount !== undefined;

  return (
    <div className="font-mono">
      {hasRepeatLine && (
        <p className="flex h-8 items-center px-3 text-micro text-fg-muted">
          {d.appliedCount.replace('{count}', String(preview.repeatCount))}
        </p>
      )}
      {preview.files.map((file, index) => {
        const { lines, hiddenCount } = truncateDiffLines(file.lines, Math.max(0, remainingLines));
        remainingLines -= lines.length;
        return (
          <FileSection
            // A patch may touch the same path twice, so only the position is
            // unique. Sections are position-stable for a given preview.
            // eslint-disable-next-line react/no-array-index-key -- op+path is not unique across a patch
            key={index}
            file={file}
            lines={lines}
            hiddenCount={hiddenCount}
            action={index === 0 ? action : undefined}
            divided={index > 0 || hasRepeatLine}
          />
        );
      })}
    </div>
  );
}

function FileSection({
  file,
  lines,
  hiddenCount,
  action,
  divided,
}: {
  file: FileChangeFilePreview;
  lines: DiffPreviewLine[];
  hiddenCount: number;
  action?: ReactNode;
  /** A hairline above the header, for every section but the panel's first. */
  divided: boolean;
}) {
  const { t } = useI18n();
  const d = t.tools.diff;
  const opLabels: Record<FileChangeFilePreview['op'], string> = {
    create: d.opCreate,
    overwrite: d.opOverwrite,
    update: d.opUpdate,
    delete: d.opDelete,
    move: d.opMove,
  };

  return (
    <div className={cn(divided && 'border-t border-stroke')}>
      {/* One 32px line: the path takes the slack and truncates (its full form is
          the title), so the action at the right end never has to wrap onto a
          row of its own. */}
      <div className="flex h-8 items-center gap-2 pr-1.5 pl-3">
        <Badge variant={OP_VARIANTS[file.op]} className="font-sans">
          {opLabels[file.op]}
        </Badge>
        <span className="min-w-0 truncate text-fg-muted" title={file.path}>
          {abbreviatePath(file.path) ?? file.path}
        </span>
        {file.movedTo && (
          <>
            <ArrowRight size={ICON_SM} className="shrink-0 text-fg-subtle" />
            <span className="min-w-0 truncate text-fg-muted" title={file.movedTo}>
              {abbreviatePath(file.movedTo) ?? file.movedTo}
            </span>
          </>
        )}
        {file.added > 0 && <span className="shrink-0 text-micro text-success">+{file.added}</span>}
        {file.removed > 0 && (
          <span className="shrink-0 text-micro text-danger">-{file.removed}</span>
        )}
        {action ? <span className="ml-auto shrink-0">{action}</span> : null}
      </div>
      {file.op === 'overwrite' && (
        <p className="px-3 pb-2 text-micro italic text-fg-subtle">{d.previousContentHidden}</p>
      )}
      {lines.length > 0 && (
        <div className="overflow-x-auto border-t border-stroke bg-canvas py-1">
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((line, index) => (
                <tr
                  // eslint-disable-next-line react/no-array-index-key -- diff lines are position-stable per render
                  key={index}
                  className={`${LINE_STYLES[line.kind].row} leading-relaxed`}
                >
                  <td className={GUTTER_CELL_CLASS}>{LINE_STYLES[line.kind].gutter}</td>
                  <td className="whitespace-pre pr-3">{line.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hiddenCount > 0 && (
        <p className="border-t border-stroke px-3 py-2 text-micro text-fg-subtle">
          {d.truncated.replace('{count}', String(hiddenCount))}
        </p>
      )}
    </div>
  );
}
