import { beforeEach, describe, expect, it } from 'bun:test';

import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Panel, repoState } from '../../support/harness/git-panel';
import { render } from '../../support/harness/render';
import { gitPanelHooks as hooks, resetGitPanelHooks } from '../../support/mocks/git-panel-hooks';

// One test per file, for the reason `git-panel-diff-suspense.test.tsx` gives: the
// diff viewer's `retryableLazy()` binding suspends only on the first open in a
// module registry, and `--isolate` gives each file its own.
beforeEach(resetGitPanelHooks);

describe('GitPanel history diff viewer chunk', () => {
  it('keeps the back control on screen while the diff viewer chunk loads, and it closes the diff', async () => {
    const user = userEvent.setup();
    const commit = {
      hash: '1234567890abcdef',
      shortHash: '1234567',
      subject: 'Ship repository navigation',
      author: 'Mango Maintainer',
      authoredAt: '2026-07-21T12:00:00.000Z',
      refs: [],
      changedFiles: 1,
      additions: 4,
      deletions: 2,
    };
    hooks.data = repoState();
    hooks.historyPages = [{ commits: [commit] }];
    hooks.commitDetails = {
      commit,
      files: [{ path: 'src/git.ts', status: 'modified', additions: 4, deletions: 2 }],
    };
    hooks.diff = { path: 'src/git.ts', binary: false, diff: '@@ -1 +1 @@\n-old\n+new\n' };

    render(<Panel />);
    await user.click(screen.getByRole('tab', { name: 'History' }));
    await user.click(screen.getByRole('button', { name: /Ship repository navigation/ }));
    // `fireEvent` dispatches synchronously, so the assertions below land before
    // the chunk settles and the Suspense fallback is what is on screen.
    fireEvent.click(screen.getByRole('button', { name: /src\/git\.ts/ }));

    expect(screen.getByText('Loading diff…')).toBeVisible();
    const region = screen.getByRole('region', { name: 'View diff for src/git.ts' });
    const back = within(region).getByRole('button', { name: 'Close diff' });
    expect(back).toBeVisible();

    // Going back while the chunk is pending cancels the load and shows the history again.
    await user.click(back);
    expect(screen.getByRole('button', { name: /Ship repository navigation/ })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'View diff for src/git.ts' })).toBeNull();

    // Let the pending import settle so it does not leak past the test.
    await act(async () => {
      await import('../../../src/features/workspace/DiffViewer');
    });
  });
});
