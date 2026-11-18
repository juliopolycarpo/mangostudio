import { describe, expect, it, jest } from 'bun:test';

import userEvent from '@testing-library/user-event';

import { DiffViewerFrame } from '../../../src/features/workspace/DiffViewerFrame';
import { render, screen } from '../../support/harness/render';

const PATH = 'apps/frontend/src/components/settings/GeneralSettings.tsx';

describe('DiffViewerFrame', () => {
  it('heads the card with the file name first and the full path as the tooltip', () => {
    render(
      <DiffViewerFrame
        selection={{ path: PATH, staged: false, title: `View diff for ${PATH}` }}
        onClose={jest.fn()}
      >
        <p>body</p>
      </DiffViewerFrame>
    );

    // A plain `truncate` on the whole path cut the file name off the end of a
    // deep path; the label keeps the name and lets only the directory give way.
    const label = screen.getByTitle(PATH);
    expect(label.querySelector('[aria-hidden="true"] > span')).toHaveTextContent(
      'GeneralSettings.tsx'
    );
    expect(screen.getByText('Working tree changes')).toBeVisible();
    expect(screen.getByRole('region', { name: `View diff for ${PATH}` })).toHaveTextContent('body');
  });

  it('names a commit diff by its short hash and calls onClose from the back control', async () => {
    const onClose = jest.fn();
    render(
      <DiffViewerFrame
        selection={{ path: PATH, commit: '1234567890abcdef', title: `View diff for ${PATH}` }}
        onClose={onClose}
      >
        <p>body</p>
      </DiffViewerFrame>
    );

    expect(screen.getByText('1234567')).toHaveAttribute('title', '1234567890abcdef');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close diff' }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
