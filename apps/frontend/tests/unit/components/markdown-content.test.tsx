import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';

import userEvent from '@testing-library/user-event';
import { act } from 'react';

import { useTheme } from '../../../src/hooks/use-theme';
import { HIGHLIGHT_FIRST_SLICE_MS } from '../../../src/lib/highlight-slices';
import { stubClipboard } from '../../support/harness/clipboard';
import { render, screen, waitFor } from '../../support/harness/render';
import { advanceTimersByTimeAsync, useFakeTimers } from '../../support/harness/timers';

// Held as their own handles rather than reached back through
// `shiki.x`: `bun test` has no `jest.mocked`, and reading the
// namespace after `mock.module` would only work by accident.
const shiki = {
  highlightCode: jest.fn<
    (
      code: string,
      language: string,
      theme: string,
      options?: { budgetMs?: number }
    ) => string | null
  >(() => null),
  initHighlighter: jest.fn(() => Promise.resolve(undefined)),
  preloadCodeLanguages: jest.fn(() => Promise.resolve(true)),
};

void mock.module('@/lib/shiki', () => ({
  ...shiki,
  CODE_THEMES: ['one-dark-pro', 'github-dark-dimmed', 'github-light', 'one-light'],
}));

// After the mock, never before: a static import is evaluated first and would
// bind the components to the real highlighter.
const { MarkdownContent } = await import('../../../src/components/MarkdownContent');
const { MarkdownContentRenderer } = await import('../../../src/components/MarkdownContentRenderer');

/** What the renderer passes the highlighter for a block's first draw: the rest is coloured in slices. */
const FIRST_DRAW_OPTIONS = { budgetMs: HIGHLIGHT_FIRST_SLICE_MS };

/** Switches the code theme the way the appearance settings do. */
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

function createPendingPreload(): Promise<boolean> {
  return new Promise(() => undefined);
}

function createDeferredPreload() {
  let resolvePreload!: (loaded: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolvePreload = resolve;
  });
  return { promise, resolvePreload };
}

describe('MarkdownContent', () => {
  beforeEach(() => {
    shiki.highlightCode.mockReset();
    shiki.highlightCode.mockReturnValue(null);
    shiki.preloadCodeLanguages.mockReset();
    shiki.preloadCodeLanguages.mockReturnValue(createPendingPreload());
  });

  it('lazy-loads the markdown renderer behind the public component', async () => {
    render(<MarkdownContent content="**bold** and *italic*" />);
    const bold = await screen.findByText('bold');
    const container = bold.closest('.markdown-content');
    if (!container) throw new Error('expected .markdown-content ancestor element');
    expect(container.querySelector('strong')).toHaveTextContent('bold');
  });

  it('renders bold and italic text', () => {
    render(<MarkdownContentRenderer content="**bold** and *italic*" />);
    const container = screen.getByText('bold').closest('.markdown-content');
    if (!container) throw new Error('expected .markdown-content ancestor element');
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('em')).toHaveTextContent('italic');
  });

  it('marks the block as streaming instead of appending a caret element', () => {
    const { container } = render(<MarkdownContentRenderer content={'first\n\nlast'} isStreaming />);

    const block = container.querySelector('.markdown-content');
    // The caret is a pseudo element on the last line's own box. A caret node of
    // its own is a block box below the final paragraph, which is what left a
    // blank line hanging under every streaming block.
    expect(block).toHaveClass('markdown-content--streaming');
    expect(block?.lastElementChild?.tagName).toBe('P');
    expect(block?.lastElementChild).toHaveTextContent('last');
  });

  it('does not mark a settled block as streaming', () => {
    const { container } = render(<MarkdownContentRenderer content="done" />);

    expect(container.querySelector('.markdown-content')).not.toHaveClass(
      'markdown-content--streaming'
    );
  });

  it('renders links with target="_blank" and rel="noopener noreferrer"', () => {
    render(<MarkdownContentRenderer content="[example](https://example.com)" />);
    const link = screen.getByText('example');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('href')).toBe('https://example.com');
  });

  it('neutralizes javascript: URLs', () => {
    render(<MarkdownContentRenderer content="[click](javascript:alert(1))" />);
    const link = screen.getByText('click');
    expect(link.getAttribute('href')).toBe('#');
  });

  it.each([
    ['mixed-case javascript', '[x](JavaScript:alert(1))'],
    ['whitespace-prefixed javascript', '[x](  javascript:alert(1))'],
    ['data URLs', '[x](data:text/html,alert)'],
    ['vbscript URLs', '[x](vbscript:msgbox(1))'],
  ])('neutralizes %s in links', (_label, content) => {
    render(<MarkdownContentRenderer content={content} />);
    expect(screen.getByText('x').getAttribute('href')).toBe('#');
  });

  it('preserves mailto and relative links', () => {
    const { container } = render(
      <MarkdownContentRenderer content={'[mail](mailto:a@b.com) and [rel](/docs/page)'} />
    );
    const [mail, rel] = Array.from(container.querySelectorAll('a'));
    expect(mail.getAttribute('href')).toBe('mailto:a@b.com');
    expect(rel.getAttribute('href')).toBe('/docs/page');
  });

  it('neutralizes unsafe schemes in image fallback links', () => {
    render(<MarkdownContentRenderer content="![pic](vbscript:msgbox(1))" />);
    expect(screen.getByText('pic').getAttribute('href')).toBe('#');
  });

  // A safe href is not enough: the anchor's *body* is interpolated into the
  // same `dangerouslySetInnerHTML` string, so raw html smuggled into the link
  // label lands in the document as live markup unless it is escaped too.
  it.each([
    [
      'an image with an error handler',
      '[click <img src=x onerror="alert(1)">](https://ok.example)',
    ],
    ['an svg with a load handler', '[x<svg onload="alert(1)">](https://ok.example)'],
  ])('escapes raw html in link text rather than emitting %s', (_label, content) => {
    const { container } = render(<MarkdownContentRenderer content={content} />);

    expect(container.querySelector('a')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });

  // Markdown hands the renderer text with its entities still written out, so
  // escaping the `&` in `&amp;` a second time renders the entity instead of
  // the character it stands for — a link label reading `a &amp; b` where the
  // same source outside a link reads `a & b`.
  it('leaves an entity the source already wrote intact in link text', () => {
    const { container } = render(
      <MarkdownContentRenderer content={'[a &amp; b](https://ok.example)'} />
    );

    expect(container.querySelector('a')).toHaveTextContent('a & b');
  });

  it('escapes html inside a code span used as link text', () => {
    const { container } = render(
      <MarkdownContentRenderer content={'[`<b>ok</b>`](https://ok.example)'} />
    );

    expect(container.querySelector('a')).toHaveTextContent('<b>ok</b>');
    expect(container.querySelector('a b')).not.toBeInTheDocument();
  });

  it('renders GFM tables', () => {
    const table = '| A | B |\n|---|---|\n| 1 | 2 |';
    const { container } = render(<MarkdownContentRenderer content={table} />);
    expect(container.querySelector('table')).toBeInTheDocument();
    expect(container.querySelector('th')).toHaveTextContent('A');
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });

  // The wrapper is what scrolls: `display: block` on the table would shrink-wrap
  // a narrow one and drop its table semantics from some screen readers.
  it('seats a table in a scroll box and keeps it a table', () => {
    const table = '| File | Tokens |\n|---|---|\n| a.css | `border-stroke`, `bg-surface-raised` |';
    const { container } = render(<MarkdownContentRenderer content={table} />);

    const scroller = container.querySelector('.markdown-content > .markdown-table-scroll');
    expect(scroller).toBeInTheDocument();
    expect(scroller?.querySelector(':scope > table')).toBeInTheDocument();
    expect(scroller?.querySelector('td code')).toHaveTextContent('border-stroke');
    expect(container.querySelectorAll('table')).toHaveLength(1);
  });

  it('renders code blocks', () => {
    const code = '```\nconst x = 1;\n```';
    const { container } = render(<MarkdownContentRenderer content={code} />);
    expect(container.querySelector('pre')).toBeInTheDocument();
    expect(container.querySelector('code')).toHaveTextContent('const x = 1;');
  });

  it('renders line breaks with breaks: true', () => {
    const { container } = render(<MarkdownContentRenderer content={'line1\nline2'} />);
    expect(container.querySelector('br')).toBeInTheDocument();
  });

  it('renders empty content as empty div', () => {
    const { container } = render(<MarkdownContentRenderer content="" />);
    const div = container.querySelector('.markdown-content');
    if (!div) throw new Error('expected .markdown-content element');
    expect(div).toBeInTheDocument();
    expect(div.innerHTML).toBe('');
  });

  it('renders correctly with isStreaming prop', () => {
    render(<MarkdownContentRenderer content="**streaming** content" isStreaming />);
    expect(screen.getByText('streaming')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(
      <MarkdownContentRenderer content="test" className="custom-class" />
    );
    expect(container.querySelector('.markdown-content.custom-class')).toBeInTheDocument();
  });

  it('memoizes parsed output for same content', () => {
    const { container } = render(<MarkdownContentRenderer content="**hello**" />);
    const el1 = container.querySelector('.markdown-content');
    if (!el1) throw new Error('expected .markdown-content element');
    const firstHtml = el1.innerHTML;

    // Re-render the same content — memoized output should be identical.
    // Use a second render instead of rerender to stay inside the ThemeProvider wrapper.
    const { container: container2 } = render(<MarkdownContentRenderer content="**hello**" />);
    const el2 = container2.querySelector('.markdown-content');
    if (!el2) throw new Error('expected .markdown-content element in second render');
    const secondHtml = el2.innerHTML;

    expect(firstHtml).toBe(secondHtml);
  });

  it('renders markdown image syntax as a stable external link', () => {
    const { container } = render(
      <MarkdownContentRenderer content="![alt text](https://example.com/img.png)" />
    );
    const link = screen.getByText('alt text');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://example.com/img.png');
    expect(link).toHaveClass('markdown-image-link');
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('escapes raw html images instead of rendering them', () => {
    const { container } = render(
      <MarkdownContentRenderer content={'<img src="https://example.com/img.png" alt="unsafe">'} />
    );

    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.querySelector('.markdown-content')).toHaveTextContent(
      '<img src="https://example.com/img.png" alt="unsafe">'
    );
  });

  it('renders nested lists', () => {
    const md = '- item 1\n  - nested 1\n  - nested 2\n- item 2';
    const { container } = render(<MarkdownContentRenderer content={md} />);
    const lists = container.querySelectorAll('ul');
    expect(lists.length).toBeGreaterThanOrEqual(2);
  });

  it('renders blockquotes', () => {
    const { container } = render(<MarkdownContentRenderer content="> a quote" />);
    expect(container.querySelector('blockquote')).toBeInTheDocument();
  });
});

describe('MarkdownContent — syntax highlighting', () => {
  const SHIKI_HTML =
    '<pre class="shiki one-dark-pro" style="background-color:#282c34;color:#abb2bf"><code><span style="color:#c678dd">const</span><span style="color:#e5c07b"> x</span><span style="color:#56b6c2"> =</span><span style="color:#d19a66"> 1</span><span style="color:#abb2bf">;</span></code></pre>';

  beforeEach(() => {
    // The theme switch below persists the chosen code theme; start each case on the default.
    window.localStorage.clear();
    shiki.highlightCode.mockReset();
    shiki.highlightCode.mockReturnValue(null);
    shiki.preloadCodeLanguages.mockReset();
    shiki.preloadCodeLanguages.mockResolvedValue(true);
  });

  it('loads fenced code languages before reparsing with Shiki', async () => {
    const preload = createDeferredPreload();
    shiki.preloadCodeLanguages.mockReturnValue(preload.promise);
    shiki.highlightCode.mockReturnValue(SHIKI_HTML);
    const { container } = render(
      <MarkdownContentRenderer content={'```typescript\nconst x = 1;\n```'} />
    );

    await act(async () => {
      preload.resolvePreload(true);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(shiki.preloadCodeLanguages).toHaveBeenCalledWith(['typescript'], 'one-dark-pro');
      expect(container.querySelector('span[style]')).toBeInTheDocument();
    });
    expect(shiki.highlightCode).toHaveBeenLastCalledWith(
      'const x = 1;',
      'typescript',
      'one-dark-pro',
      FIRST_DRAW_OPTIONS
    );
  });

  it('keeps colouring with the loaded theme while a newly chosen one is on its way', async () => {
    const user = userEvent.setup();
    shiki.preloadCodeLanguages.mockResolvedValueOnce(true);
    shiki.highlightCode.mockReturnValue(SHIKI_HTML);
    render(
      <>
        <CodeThemeSwitch />
        <MarkdownContentRenderer content={'```typescript\nconst x = 1;\n```'} />
      </>
    );
    await waitFor(() =>
      expect(shiki.highlightCode).toHaveBeenLastCalledWith(
        'const x = 1;',
        'typescript',
        'one-dark-pro',
        FIRST_DRAW_OPTIONS
      )
    );

    const nextTheme = createDeferredPreload();
    shiki.preloadCodeLanguages.mockReturnValueOnce(nextTheme.promise);
    await user.click(screen.getByRole('button', { name: 'switch code theme' }));

    // Asked for the new theme with the same languages, and has not drawn with it yet.
    await waitFor(() =>
      expect(shiki.preloadCodeLanguages).toHaveBeenLastCalledWith(
        ['typescript'],
        'github-dark-dimmed'
      )
    );
    expect(shiki.highlightCode).toHaveBeenLastCalledWith(
      'const x = 1;',
      'typescript',
      'one-dark-pro',
      FIRST_DRAW_OPTIONS
    );

    await act(async () => {
      nextTheme.resolvePreload(true);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(shiki.highlightCode).toHaveBeenLastCalledWith(
        'const x = 1;',
        'typescript',
        'github-dark-dimmed',
        FIRST_DRAW_OPTIONS
      )
    );
  });

  it('preloads languages for code blocks nested inside list items', async () => {
    shiki.preloadCodeLanguages.mockReturnValue(createPendingPreload());
    render(<MarkdownContentRenderer content={'- step one\n\n  ```rust\n  fn main() {}\n  ```'} />);

    await waitFor(() => {
      expect(shiki.preloadCodeLanguages).toHaveBeenCalledWith(['rust'], 'one-dark-pro');
    });
  });

  it('preloads the grammars of fences written inside a markdown block', async () => {
    render(
      <MarkdownContentRenderer content={'````md\n# Title\n\n```ts\nconst x = 1;\n```\n````'} />
    );

    await waitFor(() => {
      expect(shiki.preloadCodeLanguages).toHaveBeenCalledWith(
        ['markdown', 'typescript'],
        'one-dark-pro'
      );
    });
  });

  it('colours the nested fence once the embedded grammar arrives', async () => {
    const preload = createDeferredPreload();
    shiki.preloadCodeLanguages.mockReturnValue(preload.promise);
    shiki.highlightCode.mockReturnValue(SHIKI_HTML);
    const { container } = render(
      <MarkdownContentRenderer content={'````md\n```ts\nlet a;\n```\n````'} />
    );
    expect(container.querySelector('span[style]')).not.toBeInTheDocument();

    await act(async () => {
      preload.resolvePreload(true);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.querySelector('span[style]')).toBeInTheDocument();
    });
  });

  it('does not load a grammar for a fence whose info line is still streaming', async () => {
    const { rerender } = render(<MarkdownContentRenderer content={'intro\n\n```ts'} isStreaming />);
    // Let any effect that would start a preload run before asserting it did not.
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      shiki.preloadCodeLanguages,
      `preloadCodeLanguages calls: ${JSON.stringify(shiki.preloadCodeLanguages.mock.calls)}`
    ).not.toHaveBeenCalled();

    rerender(<MarkdownContentRenderer content={'intro\n\n```tsx\nconst a = <b />;'} isStreaming />);

    await waitFor(() => {
      expect(shiki.preloadCodeLanguages).toHaveBeenCalledTimes(1);
    });
    expect(shiki.preloadCodeLanguages).toHaveBeenCalledWith(['tsx'], 'one-dark-pro');
  });

  it('adds data-lang attribute to Shiki pre element', async () => {
    const preload = createDeferredPreload();
    shiki.preloadCodeLanguages.mockReturnValue(preload.promise);
    shiki.highlightCode.mockReturnValue(SHIKI_HTML);
    const { container } = render(
      <MarkdownContentRenderer content={'```typescript\nconst x = 1;\n```'} />
    );

    await act(async () => {
      preload.resolvePreload(true);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(container.querySelector('pre')?.getAttribute('data-lang')).toBe('typescript');
    });
  });

  it('falls back to plain code block when language is unknown', () => {
    shiki.preloadCodeLanguages.mockReturnValue(createPendingPreload());
    const { container } = render(
      <MarkdownContentRenderer content={'```unknownlang\nfoo()\n```'} />
    );
    expect(container.querySelector('pre')).toBeInTheDocument();
    expect(container.querySelector('pre > code')).toBeInTheDocument();
    expect(container.querySelector('span[style]')).not.toBeInTheDocument();
  });

  it('never loads the highlighter for a message whose fences have no grammar', async () => {
    const content = [
      '```vue\n<template />\n```',
      '```diff\n-a\n+b\n```',
      '```mystery\nx\n```',
    ].join('\n\n');
    render(<MarkdownContentRenderer content={content} />);
    // Let the effect that would import the highlighter run before asserting it did not.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      shiki.preloadCodeLanguages,
      `preloadCodeLanguages calls for vue, diff and unknown fences: ${JSON.stringify(shiki.preloadCodeLanguages.mock.calls)} | expected: none`
    ).not.toHaveBeenCalled();
  });

  it('asks for one grammar when ts and typescript fences share a message', async () => {
    render(
      <MarkdownContentRenderer
        content={'```ts\nlet a = 1;\n```\n\n```typescript\nlet b = 2;\n```'}
      />
    );

    await waitFor(() => {
      expect(shiki.preloadCodeLanguages).toHaveBeenCalledTimes(1);
    });
    expect(shiki.preloadCodeLanguages).toHaveBeenCalledWith(['typescript'], 'one-dark-pro');
  });

  it('renders plain code block when no language is specified', () => {
    const { container } = render(<MarkdownContentRenderer content={'```\nplain code\n```'} />);
    expect(container.querySelector('pre')).toBeInTheDocument();
    expect(container.querySelector('pre > code')).toBeInTheDocument();
    expect(container.querySelector('span[style]')).not.toBeInTheDocument();
  });

  it('falls back gracefully while Shiki highlighter is not yet loaded', () => {
    shiki.preloadCodeLanguages.mockReturnValue(createPendingPreload());
    const { container } = render(
      <MarkdownContentRenderer content={'```typescript\nconst x = 1;\n```'} />
    );
    expect(container.querySelector('pre')).toBeInTheDocument();
    expect(container.querySelector('code')).toHaveTextContent('const x = 1;');
    expect(shiki.highlightCode).not.toHaveBeenCalled();
  });

  it('adds data-lang attribute to fallback pre for language badge', () => {
    shiki.preloadCodeLanguages.mockReturnValue(createPendingPreload());
    const { container } = render(
      <MarkdownContentRenderer content={'```python\nprint("hello")\n```'} />
    );
    const pre = container.querySelector('pre');
    expect(pre?.getAttribute('data-lang')).toBe('python');
  });
});

describe('MarkdownContent — copy code button', () => {
  let clipboardWriteText: ReturnType<typeof jest.fn>;

  beforeEach(() => {
    shiki.highlightCode.mockReset();
    shiki.highlightCode.mockReturnValue(null);
    shiki.preloadCodeLanguages.mockReset();
    shiki.preloadCodeLanguages.mockReturnValue(createPendingPreload());

    clipboardWriteText = jest.fn().mockResolvedValue(undefined);
    stubClipboard(clipboardWriteText);
  });

  it('renders a copy button in each code block', () => {
    const { container } = render(<MarkdownContentRenderer content={'```\nconst x = 1;\n```'} />);
    const btn = container.querySelector('.copy-code-btn');
    expect(btn).toBeInTheDocument();
  });

  it('renders copy button even during streaming', () => {
    const { container } = render(
      <MarkdownContentRenderer content={'```\nconst x = 1;\n```'} isStreaming />
    );
    expect(container.querySelector('.copy-code-btn')).toBeInTheDocument();
  });

  it('escapes the copy button aria-label so a crafted label cannot inject attributes', () => {
    const { container } = render(
      <MarkdownContentRenderer
        content={'```\nconst x = 1;\n```'}
        copyCodeLabel={'Copy" onmouseover="alert(1)'}
      />
    );
    const btn = container.querySelector('.copy-code-btn') as HTMLButtonElement;
    expect(btn).toBeInTheDocument();
    expect(btn.getAttribute('aria-label')).toBe('Copy" onmouseover="alert(1)');
    expect(btn.hasAttribute('onmouseover')).toBe(false);
  });

  it('does not inject copy button for inline code', () => {
    const { container } = render(<MarkdownContentRenderer content={'use `inline` code here'} />);
    expect(container.querySelector('code')).toBeInTheDocument();
    expect(container.querySelector('.copy-code-btn')).not.toBeInTheDocument();
  });

  it('injects one copy button per code block', () => {
    const md = '```\nfoo()\n```\n\n```\nbar()\n```';
    const { container } = render(<MarkdownContentRenderer content={md} />);
    const pres = container.querySelectorAll('pre');
    const btns = container.querySelectorAll('.copy-code-btn');
    expect(btns).toHaveLength(pres.length);
  });

  it('calls clipboard.writeText with code text on click', async () => {
    const { container } = render(<MarkdownContentRenderer content={'```\nconst x = 1;\n```'} />);
    const btn = container.querySelector('.copy-code-btn') as HTMLButtonElement;
    btn.click();
    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith('const x = 1;');
    });
  });

  it('adds copied class to button after successful copy', async () => {
    const { container } = render(<MarkdownContentRenderer content={'```\nconst x = 1;\n```'} />);
    const btn = container.querySelector('.copy-code-btn') as HTMLButtonElement;
    btn.click();
    await waitFor(() => {
      expect(btn.classList.contains('copy-code-btn--copied')).toBe(true);
    });
  });

  it('reverts button state after 2 seconds', async () => {
    useFakeTimers();
    const { container } = render(<MarkdownContentRenderer content={'```\nconst x = 1;\n```'} />);
    const btn = container.querySelector('.copy-code-btn') as HTMLButtonElement;
    btn.click();
    await waitFor(() => expect(btn.classList.contains('copy-code-btn--copied')).toBe(true));
    await advanceTimersByTimeAsync(2000);
    expect(btn.classList.contains('copy-code-btn--copied')).toBe(false);
  });
});
