import { describe, expect, it } from 'bun:test';

import {
  buildFileChangePreview,
  type FileChangePreview,
} from '@/features/chat/components/file-change-preview';
import { FileChangePreviewBody } from '@/features/chat/components/FileChangePreview';

import { render } from '../../support/harness/render';

function editPreview(oldString: string, newString: string): FileChangePreview {
  const preview = buildFileChangePreview('edit_file', { path: '/src/a.ts', oldString, newString });
  if (!preview) throw new Error('fixture: edit_file arguments should produce a preview');
  return preview;
}

describe('FileChangePreviewBody intra-line emphasis', () => {
  it('sets the changed span off in its own element, in the row’s status tint', () => {
    const { container } = render(
      <FileChangePreviewBody preview={editPreview('return oldName(x);', 'return newName(x);')} />
    );

    const spans = [...container.querySelectorAll('td > span')];
    expect(spans.map((span) => span.textContent)).toEqual(['old', 'new']);
    expect(spans[0].className).toContain('bg-danger-subtle');
    expect(spans[1].className).toContain('bg-success-subtle');
    // Status text over two stacked tints misses 4.5:1 in the light theme, so
    // the span reads in the primary colour instead.
    expect(spans[0].className).toContain('text-fg');
  });

  it('keeps each line’s full text readable around the span', () => {
    const { container } = render(
      <FileChangePreviewBody preview={editPreview('return oldName(x);', 'return newName(x);')} />
    );

    const cells = [...container.querySelectorAll('td.whitespace-pre')].map(
      (cell) => cell.textContent
    );
    expect(cells).toEqual(['return oldName(x);', 'return newName(x);']);
  });

  it('draws no span for a line pair with nothing in common', () => {
    const { container } = render(
      <FileChangePreviewBody preview={editPreview('alpha', 'omega-')} />
    );
    expect(container.querySelectorAll('td > span')).toHaveLength(0);
  });
});
