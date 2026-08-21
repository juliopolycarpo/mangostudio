import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { act } from 'react';
import { render, screen, waitFor } from '../../support/harness/render';
import { advanceTimersByTimeAsync, useFakeTimers } from '../../support/harness/timers';

// Held as their own handles rather than reached back through
// `shiki.x`: `bun test` has no `jest.mocked`, and reading the
// namespace after `mock.module` would only work by accident.
const shiki = {
  highlightCode: jest.fn<(code: string, language: string, theme: string) => string | null>(
    () => null
  ),
  initHighlighter: jest.fn(() => Promise.resolve(undefined)),
  preloadCodeLanguages: jest.fn(() => Promise.resolve(true)),
};

mock.module('@/lib/shiki', () => ({
  ...shiki,
  CODE_THEMES: ['one-dark-pro', 'github-dark-dimmed', 'github-light', 'one-light'],
}));

// After the mock, never before: a static import is evaluated first and would
// bind the components to the real highlighter.
const { MarkdownContent } = await import('../../../src/components/MarkdownContent');
const { MarkdownContentRenderer } = await import('../../../src/components/MarkdownContentRenderer');

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

  it('renders GFM tables', () => {
    const table = '| A | B |\n|---|---|\n| 1 | 2 |';
    const { container } = render(<MarkdownContentRenderer content={table} />);
    expect(container.querySelector('table')).toBeInTheDocument();
    expect(container.querySelector('th')).toHaveTextContent('A');
    expect(container.querySelectorAll('td')).toHaveLength(2);
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
      expect(shiki.preloadCodeLanguages).toHaveBeenCalledWith(['typescript']);
      expect(container.querySelector('span[style]')).toBeInTheDocument();
    });
    expect(shiki.highlightCode).toHaveBeenLastCalledWith(
      'const x = 1;',
      'typescript',
      'one-dark-pro'
    );
  });

  it('preloads languages for code blocks nested inside list items', async () => {
    shiki.preloadCodeLanguages.mockReturnValue(createPendingPreload());
    render(<MarkdownContentRenderer content={'- step one\n\n  ```rust\n  fn main() {}\n  ```'} />);

    await waitFor(() => {
      expect(shiki.preloadCodeLanguages).toHaveBeenCalledWith(['rust']);
    });
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
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: clipboardWriteText },
      configurable: true,
      writable: true,
    });
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
