/**
 * Terminal, markdown and diff viewer each load a chunk on first use. A chunk
 * that cannot be fetched used to replace the whole page through the route's
 * error component; each must now fail where it sits. Their first import fails
 * here and the next succeeds, the way a dropped connection comes back.
 *
 * One file because each lazy binding is module-level and keeps its first result.
 */

import { describe, expect, it, mock, spyOn } from 'bun:test';

import { en } from '@mangostudio/shared/i18n';
import userEvent from '@testing-library/user-event';

import { render, screen, waitFor } from '../../support/harness/render';

const chunkState = {
  terminalFailuresLeft: 1,
  markdownFailuresLeft: 1,
  markdownEvaluations: 0,
  diffFailuresLeft: 1,
};

function failedImport(chunk: string): never {
  throw new TypeError(`Failed to fetch dynamically imported module: /assets/chunk-${chunk}.js`);
}

function TerminalViewStub({ sessionId }: { sessionId: string }) {
  return <div data-testid="terminal-view-stub">{sessionId}</div>;
}

void mock.module('../../../src/features/terminal/TerminalView', () => {
  if (chunkState.terminalFailuresLeft > 0) {
    chunkState.terminalFailuresLeft -= 1;
    failedImport('TerminalView');
  }
  return { TerminalView: TerminalViewStub };
});

function MarkdownContentRendererStub({ content }: { content: string }) {
  return <div data-testid="markdown-rendered">{content.toUpperCase()}</div>;
}

void mock.module('../../../src/components/MarkdownContentRenderer', () => {
  chunkState.markdownEvaluations += 1;
  if (chunkState.markdownFailuresLeft > 0) {
    chunkState.markdownFailuresLeft -= 1;
    failedImport('MarkdownContentRenderer');
  }
  return { MarkdownContentRenderer: MarkdownContentRendererStub };
});

function DiffViewerStub({ chatId }: { chatId: string }) {
  return <div data-testid="diff-viewer-stub">{chatId}</div>;
}

void mock.module('../../../src/features/workspace/DiffViewer', () => {
  if (chunkState.diffFailuresLeft > 0) {
    chunkState.diffFailuresLeft -= 1;
    failedImport('DiffViewer');
  }
  return { DiffViewer: DiffViewerStub };
});

const { LazyTerminalView } = await import('../../../src/features/terminal/LazyTerminalView');
const { MarkdownContent } = await import('../../../src/components/MarkdownContent');
const { LazyDiffViewer } = await import('../../../src/features/workspace/LazyDiffViewer');

describe('a lazy chunk that cannot be fetched', () => {
  it('shows the terminal failure in place and recovers on Retry', async () => {
    const user = userEvent.setup();
    render(<LazyTerminalView sessionId="session-1" />);

    expect(await screen.findByTestId('lazy-chunk-failure')).toHaveTextContent(
      en.errors.lazyChunk.title
    );

    await user.click(screen.getByRole('button', { name: en.common.retry }));
    expect(await screen.findByTestId('terminal-view-stub')).toHaveTextContent('session-1');
  });

  it('keeps markdown readable as plain text, and asks the network again only after the backoff', async () => {
    const clock = spyOn(Date, 'now');
    const startedAt = Date.now();
    clock.mockImplementation(() => startedAt);

    const first = render(<MarkdownContent content={'line one\n  indented'} />);

    // The failure panel never appears: the text the person is reading stays,
    // with its line breaks, and says it is the failure form (not the loading one).
    const failedText = await waitFor(() => {
      const failed = document.querySelector('[data-markdown-fallback="failed"]');
      if (!failed) throw new Error('expected the failed markdown fallback | received: none yet');
      return failed;
    });
    expect(failedText).toHaveTextContent('line one');
    expect(failedText.className).toContain('whitespace-pre-wrap');
    expect(screen.queryByTestId('lazy-chunk-failure')).not.toBeInTheDocument();
    expect(chunkState.markdownEvaluations).toBe(1);
    first.unmount();

    // A message that mounts inside the backoff (a feed row scrolling back in)
    // does not touch the network again.
    const second = render(<MarkdownContent content="second message" />);
    await waitFor(() =>
      expect(document.querySelector('[data-markdown-fallback="failed"]')).not.toBeNull()
    );
    expect(chunkState.markdownEvaluations, 'evaluations inside the backoff').toBe(1);
    second.unmount();

    // Past the backoff the next mount asks again, and the renderer arrives.
    clock.mockImplementation(() => startedAt + 5_000);
    render(<MarkdownContent content="third message" />);
    expect(await screen.findByTestId('markdown-rendered')).toHaveTextContent('THIRD MESSAGE');
    expect(chunkState.markdownEvaluations, 'evaluations after the backoff').toBe(2);
    clock.mockRestore();
  });

  it('heals a diff viewer on a later mount, without a Retry click, once the backoff passed', async () => {
    const clock = spyOn(Date, 'now');
    const startedAt = Date.now();
    clock.mockImplementation(() => startedAt);
    const selection = { path: 'a.ts', staged: false, title: 'a.ts' };

    const first = render(
      <LazyDiffViewer chatId="chat-9" selection={selection} onClose={() => undefined} />
    );
    expect(await screen.findByTestId('lazy-chunk-failure')).toBeInTheDocument();
    first.unmount();

    clock.mockImplementation(() => startedAt + 5_000);
    render(<LazyDiffViewer chatId="chat-9" selection={selection} onClose={() => undefined} />);

    expect(await screen.findByTestId('diff-viewer-stub')).toHaveTextContent('chat-9');
    clock.mockRestore();
  });
});
