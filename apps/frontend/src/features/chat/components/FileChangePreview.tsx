import { ArrowRight } from 'lucide-react';
import type { ComponentProps } from 'react';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import {
  DIFF_PREVIEW_MAX_LINES,
  type DiffPreviewLine,
  type FileChangeFilePreview,
  type FileChangePreview,
  truncateDiffLines,
} from './file-change-preview';

interface FileChangePreviewBodyProps {
  preview: FileChangePreview;
}

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
 * // Usage: <FileChangePreviewBody preview={preview} />
 */
export function FileChangePreviewBody({ preview }: FileChangePreviewBodyProps) {
  const { t } = useI18n();
  const d = t.tools.diff;
  // The render budget is shared across files so a many-file patch cannot
  // multiply it away.
  let remainingLines = DIFF_PREVIEW_MAX_LINES;

  return (
    <div className="space-y-3 font-mono">
      {preview.repeatCount !== undefined && (
        <p className="text-micro text-fg-muted">
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
            // biome-ignore lint/suspicious/noArrayIndexKey: op+path is not unique across a patch
            key={index}
            file={file}
            lines={lines}
            hiddenCount={hiddenCount}
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
}: {
  file: FileChangeFilePreview;
  lines: DiffPreviewLine[];
  hiddenCount: number;
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
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge variant={OP_VARIANTS[file.op]} className="font-sans">
          {opLabels[file.op]}
        </Badge>
        <span className="min-w-0 truncate text-fg-muted">{file.path}</span>
        {file.movedTo && (
          <>
            <ArrowRight size={ICON_SM} className="shrink-0 text-fg-subtle" />
            <span className="min-w-0 truncate text-fg-muted">{file.movedTo}</span>
          </>
        )}
        {file.added > 0 && <span className="shrink-0 text-micro text-success">+{file.added}</span>}
        {file.removed > 0 && (
          <span className="shrink-0 text-micro text-danger">-{file.removed}</span>
        )}
      </div>
      {file.op === 'overwrite' && (
        <p className="mb-1 text-micro italic text-fg-subtle">{d.previousContentHidden}</p>
      )}
      {lines.length > 0 && (
        <div className="overflow-x-auto rounded-sm border border-stroke bg-canvas">
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((line, index) => (
                <tr
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are position-stable per render
                  key={index}
                  className={`${LINE_STYLES[line.kind].row} leading-relaxed`}
                >
                  <td className="w-4 select-none px-1.5 text-center">
                    {LINE_STYLES[line.kind].gutter}
                  </td>
                  <td className="whitespace-pre pr-2">{line.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hiddenCount > 0 && (
        <p className="mt-1 text-micro text-fg-subtle">
          {d.truncated.replace('{count}', String(hiddenCount))}
        </p>
      )}
    </div>
  );
}
