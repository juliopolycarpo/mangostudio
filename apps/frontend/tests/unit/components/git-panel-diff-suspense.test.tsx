import { beforeEach, describe, expect, it } from 'bun:test';

import { act, fireEvent, screen, within } from '@testing-library/react';

import { Panel, repoState } from '../../support/harness/git-panel';
import { render } from '../../support/harness/render';
import { gitPanelHooks as hooks, resetGitPanelHooks } from '../../support/mocks/git-panel-hooks';

// This file holds exactly one test, on purpose. `LazyDiffViewer` binds a
// module-level `retryableLazy()` singleton, and once its dynamic import has
// resolved React never suspends on it again, so only the first diff opened in a
// module registry ever shows the fallback. `bun test --isolate` gives each file
// its own registry; a second diff-opening test belongs in `git-panel.test.tsx`,
// not here.
beforeEach(resetGitPanelHooks);

describe('GitPanel diff viewer chunk', () => {
  it('shows a loading spinner instead of a blank panel while the diff viewer chunk loads', async () => {
    hooks.data = repoState({
      status: {
        branch: { name: 'feat/git-panel', ahead: 0, behind: 0 },
        staged: [],
        unstaged: [{ path: 'src/panel.tsx', status: 'modified' }],
        untracked: [],
        conflicted: [],
        clean: false,
      },
    });
    hooks.diff = {
      path: 'src/panel.tsx',
      binary: false,
      diff: '@@ -4,2 +4,2 @@\n-old title\n+new title\n',
    };

    render(<Panel />);
    // `fireEvent` (unlike `userEvent`) dispatches synchronously, so this
    // assertion lands before the import settles on the microtask queue -- the
    // Suspense fallback, not a blank panel, is what's on screen at this point.
    fireEvent.click(screen.getByRole('button', { name: 'View diff for src/panel.tsx' }));

    expect(screen.getByText('Loading diff…')).toBeVisible();
    // The frame is not part of the chunk: the region and its back control are
    // already on screen while the viewer body is still pending.
    const region = screen.getByRole('region', { name: 'View diff for src/panel.tsx' });
    expect(within(region).getByRole('button', { name: 'Close diff' })).toBeVisible();

    // Await the chunk itself: a cold import can exceed findByRole's deadline.
    await act(async () => {
      await import('../../../src/features/workspace/DiffViewer');
    });

    expect(screen.queryByText('Loading diff…')).toBeNull();
    expect(screen.getByRole('region', { name: 'View diff for src/panel.tsx' })).toBeVisible();
  });
});
