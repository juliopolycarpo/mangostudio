import { afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import type { GitDiffResponse } from '@mangostudio/shared/git';
import { CODE_THEMES, initHighlighter, preloadCodeLanguages } from '@/lib/shiki';
import { stubClipboard } from '../../support/harness/clipboard';
import { fireEvent, flushAsyncRender, render, screen, waitFor } from '../../support/harness/render';

const git = { diff: undefined as GitDiffResponse | undefined };

function useFakeGitDiff() {
  return { data: git.diff, isLoading: false, error: null };
}

mock.module('../../../src/features/workspace/hooks/use-git-state', () => ({
  useGitDiff: useFakeGitDiff,
}));

const { MarkdownContentRenderer } = await import('../../../src/components/MarkdownContentRenderer');
const { DiffViewer } = await import('../../../src/features/workspace/DiffViewer');
let highlighter: Awaited<ReturnType<typeof initHighlighter>>;
let restore: (() => void) | undefined;

beforeAll(async () => {
  await preloadCodeLanguages(['ts']);
  highlighter = await initHighlighter();
  const realNow = Date.now;
  try {
    // These tests isolate consumer behavior; cold cooperative stops have their own matrix.
    Date.now = unchangedClock;
    for (const theme of CODE_THEMES) {
      highlighter.codeToHtml('const value = 42;', { lang: 'typescript', theme });
    }
  } finally {
    Date.now = realNow;
  }
});

afterEach(() => {
  restore?.();
  restore = undefined;
});

function stopRealTokenizer() {
  const grammar = highlighter.getLanguage('typescript');
  const original = grammar.tokenizeLine2;
  const tokenizer = spyOn(grammar, 'tokenizeLine2').mockImplementation(function (
    this: typeof grammar,
    ...args
  ) {
    return { ...original.apply(this, args), stoppedEarly: true };
  });
  restore = () => tokenizer.mockRestore();
  return tokenizer;
}

function failLanguageLoad(): Promise<void> {
  return Promise.reject(new Error('Synthetic language module download failure'));
}

function writeClipboard(_text: string): Promise<void> {
  return Promise.resolve();
}

function unchangedClock(): number {
  return 0;
}

class PendingLanguageLoad {
  readonly result = Promise.withResolvers<void>();
  load = () => this.result.promise;
}

function showDiff(path: string, source: string) {
  git.diff = { path, binary: false, diff: `@@ -0,0 +1 @@\n+${source}\n` };
  return render(
    <DiffViewer
      chatId="chat-highlight"
      selection={{ path, staged: false, title: `View diff for ${path}` }}
      onClose={mock()}
    />
  );
}

describe('actual consumers of checked highlighting', () => {
  it('keeps valid fences highlighted alongside an inherited-key language fence', async () => {
    const { container } = render(
      <MarkdownContentRenderer
        content={'```constructor\nplain source\n```\n\n```typescript\nconst value = 42;\n```'}
      />
    );
    await waitFor(() =>
      expect(container.querySelector('pre[data-lang="typescript"]')).toHaveClass('shiki')
    );
    expect(container.querySelector('pre[data-lang="constructor"]')?.textContent).toContain(
      'plain source'
    );
    expect(container.querySelector('pre[data-lang="constructor"]')).not.toHaveClass('shiki');
  });

  it('keeps escaped multiline source and its copy control after real tokenization stops', async () => {
    const tokenizer = stopRealTokenizer();
    const source = `<script>alert("café & 漢字")</script> ${'x'.repeat(8192)}\nsecond line <tag>`;
    const clipboard = mock(writeClipboard);
    stubClipboard(clipboard);
    const { container } = render(
      <MarkdownContentRenderer content={`\`\`\`typescript\n${source}\n\`\`\``} />
    );

    await waitFor(() => expect(tokenizer).toHaveBeenCalled());
    expect(container.querySelector('code')?.textContent).toBe(source);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('pre')).toHaveAttribute('data-lang', 'typescript');
    expect(container.querySelector('.shiki')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith(source));
  });

  it('keeps diff source, selection and addition chrome after real tokenization stops', async () => {
    const tokenizer = stopRealTokenizer();
    const source = 'const value = "café & <tag>";';
    const { container } = showDiff('example.ts', source);
    await waitFor(() => expect(tokenizer).toHaveBeenCalled());

    const code = container.querySelector('code');
    expect(code?.textContent).toBe(source);
    expect(code?.querySelector('span')).toBeNull();
    expect(code?.parentElement).toHaveClass('bg-success-subtle');
    expect(code?.parentElement?.textContent).toContain('1');
    expect(code?.parentElement?.textContent).toContain('+');
    expect(code).not.toHaveClass('select-none');
  });

  it('keeps plain Markdown and copy available when a language download rejects', async () => {
    const loading = spyOn(highlighter, 'loadLanguage').mockImplementationOnce(failLanguageLoad);
    restore = () => loading.mockRestore();
    const { container, unmount } = render(
      <MarkdownContentRenderer content={'```ruby\nputs "café & <tag>"\n```'} />
    );
    await waitFor(() => expect(loading).toHaveBeenCalledWith('ruby'));
    await flushAsyncRender();
    expect(container.querySelector('code')?.textContent).toBe('puts "café & <tag>"');
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeVisible();
    unmount();
    await flushAsyncRender();
  });

  it('keeps plain diff chrome when a language download rejects', async () => {
    const loading = spyOn(highlighter, 'loadLanguage').mockImplementationOnce(failLanguageLoad);
    restore = () => loading.mockRestore();
    const { container, unmount } = showDiff('example.go', 'package main');
    await waitFor(() => expect(loading).toHaveBeenCalledWith('go'));
    await flushAsyncRender();
    expect(container.querySelector('code')?.textContent).toBe('package main');
    expect(container.querySelector('code')?.parentElement).toHaveClass('bg-success-subtle');
    unmount();
    await flushAsyncRender();
  });

  it('consumes a late Markdown language failure after unmount', async () => {
    const pending = new PendingLanguageLoad();
    const loading = spyOn(highlighter, 'loadLanguage').mockImplementationOnce(pending.load);
    restore = () => loading.mockRestore();
    const { container, unmount } = render(
      <MarkdownContentRenderer content={'```java\nclass Example {}\n```'} />
    );
    await waitFor(() => expect(loading).toHaveBeenCalledWith('java'));
    unmount();
    pending.result.reject(new Error('Synthetic late language download failure'));
    await flushAsyncRender();
    expect(container.childElementCount).toBe(0);
  });

  it('consumes a late diff language failure after unmount', async () => {
    const pending = new PendingLanguageLoad();
    const loading = spyOn(highlighter, 'loadLanguage').mockImplementationOnce(pending.load);
    restore = () => loading.mockRestore();
    const { container, unmount } = showDiff('example.swift', 'let value = 42');
    await waitFor(() => expect(loading).toHaveBeenCalledWith('swift'));
    unmount();
    pending.result.reject(new Error('Synthetic late language download failure'));
    await flushAsyncRender();
    expect(container.childElementCount).toBe(0);
  });
});
