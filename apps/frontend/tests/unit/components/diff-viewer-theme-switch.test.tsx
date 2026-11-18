import { describe, expect, it, mock, spyOn } from 'bun:test';

import type { GitDiffResponse } from '@mangostudio/shared/git';
import userEvent from '@testing-library/user-event';

import { initHighlighter, preloadCodeLanguages } from '@/lib/shiki';

import { useTheme } from '../../../src/hooks/use-theme';
import { render, waitFor } from '../../support/harness/render';

// Kept apart from shiki-consumers.test.tsx, which loads every theme up front:
// this case is about a theme the highlighter has not loaded yet.
const git = { diff: undefined as GitDiffResponse | undefined };

function useFakeGitDiff() {
  return { data: git.diff, isLoading: false, error: null };
}

void mock.module('../../../src/features/workspace/hooks/use-git-state', () => ({
  useGitDiff: useFakeGitDiff,
}));

const { DiffViewer } = await import('../../../src/features/workspace/DiffViewer');

function CodeThemeSwitch() {
  const { setConfig } = useTheme();
  return (
    <button
      type="button"
      onClick={() =>
        setConfig({
          codeTheme: {
            mode: 'manual',
            darkTheme: 'github-dark-dimmed',
            lightTheme: 'github-light',
          },
        })
      }
    >
      switch code theme
    </button>
  );
}

function tokenColours(container: HTMLElement): string[] {
  return [...container.querySelectorAll('code span[style]')].map(
    (span) => (span as HTMLElement).style.color
  );
}

describe('DiffViewer code theme switch', () => {
  it('keeps the colours of the loaded theme until the newly chosen theme arrives', async () => {
    window.localStorage.clear();
    const realNow = Date.now;
    // Tokenizing a cold grammar can stop on its time budget; this case is about theme loading.
    Date.now = () => 0;
    try {
      await preloadCodeLanguages(['ts'], 'one-dark-pro');
      const highlighter = await initHighlighter();
      expect(highlighter.getLoadedThemes(), 'themes loaded before the switch').toEqual([
        'one-dark-pro',
      ]);

      git.diff = {
        path: 'example.ts',
        binary: false,
        // A context row: added and removed rows mix their token colours with a CSS variable.
        diff: '@@ -1 +1 @@\n const value = 42;\n',
      };
      const consoleErrors = spyOn(console, 'error');
      const themeArrival = Promise.withResolvers<void>();
      const realLoadTheme = highlighter.loadTheme.bind(highlighter);
      const loadTheme = spyOn(highlighter, 'loadTheme').mockImplementation(async (...themes) => {
        await themeArrival.promise;
        return realLoadTheme(...themes);
      });

      const { container } = render(
        <>
          <CodeThemeSwitch />
          <DiffViewer
            chatId="chat-theme-switch"
            selection={{ path: 'example.ts', staged: false, title: 'View diff for example.ts' }}
          />
        </>
      );
      await waitFor(() => expect(tokenColours(container).length).toBeGreaterThan(0));
      const darkColours = tokenColours(container);

      await userEvent.setup().click(container.querySelector('button') as HTMLElement);
      await waitFor(() => expect(loadTheme).toHaveBeenCalledWith('github-dark-dimmed'));

      // The new theme is not loaded yet: rows keep the old colours and nothing throws.
      expect(
        tokenColours(container),
        'token colours while github-dark-dimmed is still loading'
      ).toEqual(darkColours);
      expect(consoleErrors).not.toHaveBeenCalled();

      themeArrival.resolve();
      await waitFor(() => {
        const colours = tokenColours(container);
        expect(colours.length, 'coloured tokens after the theme arrived').toBeGreaterThan(0);
        expect(colours, 'colours after github-dark-dimmed arrived').not.toEqual(darkColours);
      });
      loadTheme.mockRestore();
      consoleErrors.mockRestore();
    } finally {
      Date.now = realNow;
    }
  });
});
