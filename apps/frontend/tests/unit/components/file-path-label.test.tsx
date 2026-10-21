import { describe, expect, it } from 'bun:test';
import { FilePathLabel } from '../../../src/features/workspace/components/FilePathLabel';
import { render, screen } from '../../support/harness/render';

describe('FilePathLabel', () => {
  it('reads the whole path to assistive tech and in the tooltip', () => {
    const { container } = render(<FilePathLabel path="apps/frontend/src/git.ts" />);

    expect(screen.getByText('apps/frontend/src/git.ts')).toHaveClass('sr-only');
    expect(container.querySelector('[title]')).toHaveAttribute('title', 'apps/frontend/src/git.ts');
  });

  // Every row of a list shares its first segments, so the cut falls on the left
  // and the segment nearest the file survives. The text is an isolated LTR run,
  // or a leading dot would be moved to the far end (`github/workflows.`).
  it('cuts the directory from the left and keeps its text in an isolated LTR run', () => {
    render(<FilePathLabel path=".github/workflows/ci.yml" />);

    const dir = screen.getByText('.github/workflows');
    expect(dir.tagName).toBe('BDI');
    expect(dir).toHaveAttribute('dir', 'ltr');
    expect(dir.parentElement).toHaveAttribute('dir', 'rtl');
    expect(dir.parentElement).toHaveClass('truncate', 'text-left');
  });

  it('shows a pure move as the old directory struck through, then the new one', () => {
    render(<FilePathLabel path="b/dir/a.ts" oldPath="a/dir/a.ts" />);

    const old = screen.getByText('a/dir');
    expect(old).toHaveClass('line-through');
    expect(old.closest('bdi')).toHaveAttribute('dir', 'ltr');
    expect(old.closest('[dir="rtl"]')).not.toBeNull();
  });

  it('keeps the stacked layout on the right-hand cut', () => {
    render(<FilePathLabel path="apps/frontend/src/git.ts" stacked />);

    expect(screen.getByText('apps/frontend/src').closest('[dir="rtl"]')).toBeNull();
  });
});
