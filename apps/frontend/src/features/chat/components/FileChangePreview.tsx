import { ArrowRight } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';
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

const OP_TONES: Record<FileChangeFilePreview['op'], string> = {
  create: 'bg-success-subtle text-success',
  overwrite: 'bg-accent-subtle text-accent-fg',
  update: 'bg-accent-subtle text-accent-fg',
  delete: 'bg-danger-subtle text-danger',
  move: 'bg-surface text-fg-muted',
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
    <div className="space-y-3">
      {preview.repeatCount !== undefined && (
        <p className="text-fg-muted text-[11px]">
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
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${OP_TONES[file.op]}`}
        >
          {opLabels[file.op]}
        </span>
        <span className="min-w-0 truncate text-fg-muted">{file.path}</span>
        {file.movedTo && (
          <>
            <ArrowRight size={9} className="shrink-0 text-fg-subtle" />
            <span className="min-w-0 truncate text-fg-muted">{file.movedTo}</span>
          </>
        )}
        {file.added > 0 && <span className="shrink-0 text-[10px] text-success">+{file.added}</span>}
        {file.removed > 0 && (
          <span className="shrink-0 text-[10px] text-danger">-{file.removed}</span>
        )}
      </div>
      {file.op === 'overwrite' && (
        <p className="mb-1 text-[10px] text-fg-subtle italic">{d.previousContentHidden}</p>
      )}
      {lines.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-stroke bg-control">
          <table className="w-full border-collapse">
            <tbody>
              {lines.map((line, index) => (
                <tr
                  // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are position-stable per render
                  key={index}
                  className={`${LINE_STYLES[line.kind].row} leading-relaxed`}
                >
                  <td className="w-4 select-none px-1.5 text-center opacity-60">
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
        <p className="mt-1 text-[10px] text-fg-subtle">
          {d.truncated.replace('{count}', String(hiddenCount))}
        </p>
      )}
    </div>
  );
}
