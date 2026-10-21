import { describe, expect, it, jest, mock } from 'bun:test';
import type { GitDiffResponse } from '@mangostudio/shared/git';
import { flushAsyncRender, render, screen, waitFor } from '../../support/harness/render';

const hooks = {
  diff: undefined as GitDiffResponse | undefined,
};

mock.module('../../../src/features/workspace/hooks/use-git-state', () => ({
  useGitDiff: () => ({ data: hooks.diff, isLoading: false, error: null }),
}));

// Every token gets a known colour, so the style each line carries is the
// viewer's doing and not the highlighter's.
mock.module('@/lib/shiki', () => ({
  CODE_THEMES: ['one-dark-pro', 'github-dark-dimmed', 'github-light', 'one-light'],
  highlightLineTokens: (line: string) => [{ content: line, offset: 0, color: '#d73a49' }],
  preloadCodeLanguages: jest.fn(() => Promise.resolve(true)),
}));

// After the mocks, never before: a static import is evaluated first and would
// bind the viewer to the real highlighter and the real git hooks.
const { DiffViewer } = await import('../../../src/features/workspace/DiffViewer');

const PATH = 'apps/frontend/src/components/settings/GeneralSettings.tsx';

function renderViewer() {
  hooks.diff = {
    path: PATH,
    binary: false,
    diff: '@@ -1,2 +1,2 @@\n context line\n-old line\n+new line\n',
  };
  return render(
    <DiffViewer
      chatId="chat-1"
      selection={{ path: PATH, staged: false, title: `View diff for ${PATH}` }}
      onClose={jest.fn()}
    />
  );
}

describe('DiffViewer', () => {
  it('heads the card with the file name first and the full path as the tooltip', async () => {
    renderViewer();
    await flushAsyncRender();

    // A plain `truncate` on the whole path cut the file name off the end of a
    // deep path; the label keeps the name and lets only the directory give way.
    const label = screen.getByTitle(PATH);
    expect(label.querySelector('[aria-hidden="true"] > span')).toHaveTextContent(
      'GeneralSettings.tsx'
    );
    expect(screen.getByText('Working tree changes')).toBeVisible();
  });

  it('pulls syntax colours toward the foreground on added and removed lines only', async () => {
    renderViewer();

    const styleOf = (text: string) => screen.getByText(text).getAttribute('style') ?? '';
    // The highlighter loads after the first paint; the context line is the one
    // that keeps the theme's colour, so it says when the tokens are in.
    await waitFor(() => expect(styleOf('context line')).toContain('#d73a49'));

    // Shiki's colours are tuned for the theme's own background; on the app's
    // success and danger fills they fell below 4.5:1, so those lines carry a
    // `color-mix(in srgb, <token> 50%, var(--color-fg))` instead of the raw
    // colour. happy-dom does not parse `color-mix` and drops the declaration, so
    // what this can pin is that the raw theme colour is not applied there.
    expect(styleOf('new line')).not.toContain('#d73a49');
    expect(styleOf('old line')).not.toContain('#d73a49');
  });

  it('draws exactly the lines the hunk header counts, with no row for the final newline', async () => {
    const { container } = renderViewer();
    await flushAsyncRender();

    // `git diff` ends in a newline; the empty string after it once became a
    // context row numbered one past the hunk.
    expect(Array.from(container.querySelectorAll('code'), (code) => code.textContent)).toEqual([
      'context line',
      'old line',
      'new line',
    ]);
  });
});
