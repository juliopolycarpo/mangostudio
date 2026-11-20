import { afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';

import type { GitDiffResponse } from '@mangostudio/shared/git';

import { CODE_THEMES, initHighlighter, preloadCodeLanguages } from '@/lib/shiki';

import { stubClipboard } from '../../support/harness/clipboard';
import { pinTokenizerClockPerTest } from '../../support/harness/pinned-tokenizer-clock';
import { fireEvent, flushAsyncRender, render, screen, waitFor } from '../../support/harness/render';

const git = { diff: undefined as GitDiffResponse | undefined };

pinTokenizerClockPerTest();

function useFakeGitDiff() {
  return { data: git.diff, isLoading: false, error: null };
}

void mock.module('../../../src/features/workspace/hooks/use-git-state', () => ({
  useGitDiff: useFakeGitDiff,
}));

const { MarkdownContentRenderer } = await import('../../../src/components/MarkdownContentRenderer');
const { DiffViewer } = await import('../../../src/features/workspace/DiffViewer');
let highlighter: Awaited<ReturnType<typeof initHighlighter>>;
let restore: (() => void) | undefined;

/** The body of the streaming case's fence as it stands before its closing fence and last chunk arrive. */
const STREAMED_OPEN_BODY = 'const first = 1;\nfunction second(value: number) {\n  return value';

/**
 * Sources tokenized once, with a frozen clock, before any case runs. The JavaScript regex engine
 * compiles a grammar rule the first time a line reaches it, so a case that is the first to use
 * `function`, a parameter type or `return` pays that compile inside its own tokenize call: about
 * 140 ms on an idle machine, and past the product's 500 ms `tokenizeTimeLimit` when the machine is
 * busy. The tokenizer then stops, the block stays plain and no later render colours it, so
 * `waitFor` never sees `shiki`, however long it waits. Every case that expects colour from the
 * real tokenizer has its constructs listed here, so what it checks is the consumer and not
 * the speed of the runner.
 */
const REAL_TOKENIZER_WARMUP_SOURCES = [
  'const value = 42;',
  `${STREAMED_OPEN_BODY} + 1;\n}`,
] as const;

beforeAll(async () => {
  await preloadCodeLanguages(['ts'], 'one-dark-pro');
  highlighter = await initHighlighter();
  // The cases below colour every theme, and only the requested one is loaded by default.
  for (const theme of CODE_THEMES) await highlighter.loadTheme(theme);
  const realNow = Date.now;
  try {
    // These tests isolate consumer behavior; cold cooperative stops have their own matrix.
    Date.now = unchangedClock;
    for (const theme of CODE_THEMES) {
      for (const source of REAL_TOKENIZER_WARMUP_SOURCES) {
        highlighter.codeToHtml(source, { lang: 'typescript', theme });
      }
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

function countRealTokenizerCalls() {
  const grammar = highlighter.getLanguage('typescript');
  const tokenizer = spyOn(grammar, 'tokenizeLine2');
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
    // Many lines under the highlight limits, so the tokenizer runs and then stops; one 8 KB
    // unbroken token would be refused before it (see the next case) and cost seconds.
    const longBody = `${'x'.repeat(100)}\n`.repeat(80);
    const source = `<script>alert("café & 漢字")</script> ${longBody}second line <tag>`;
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

  it('colours a code block while its fence is still open and the message is streaming', async () => {
    const open = `\`\`\`typescript\n${STREAMED_OPEN_BODY}`;
    const { container, rerender } = render(<MarkdownContentRenderer content={open} isStreaming />);
    await waitFor(() =>
      expect(container.querySelector('pre[data-lang="typescript"]')).toHaveClass('shiki')
    );

    rerender(<MarkdownContentRenderer content={`${open} + 1;\n}`} isStreaming />);
    const coloured = container.querySelectorAll('pre.shiki span[style*="color"]');
    expect(
      coloured.length,
      'coloured spans in a streamed block whose closing fence has not arrived'
    ).toBeGreaterThan(5);
    expect(container.querySelector('pre.shiki')?.textContent).toContain('return value + 1;');
  });

  it('keeps escaped source and its copy control for a block over the highlight limits, without tokenizing it', async () => {
    const tokenizer = countRealTokenizerCalls();
    const source = `<script>alert("café & 漢字")</script> ${'x'.repeat(16_384)}\nsecond line <tag>`;
    const clipboard = mock(writeClipboard);
    stubClipboard(clipboard);
    const { container } = render(
      <MarkdownContentRenderer content={`\`\`\`typescript\n${source}\n\`\`\``} />
    );

    await flushAsyncRender();
    expect(container.querySelector('code')?.textContent).toBe(source);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('.shiki')).toBeNull();
    expect(tokenizer.mock.calls.length, 'tokenizer calls for an over-limit block').toBe(0);
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
