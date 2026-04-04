import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '../../support/harness/render';
import { MarkdownContent } from '../../../src/components/MarkdownContent';
import * as shikiLib from '@/lib/shiki';

vi.mock('@/lib/shiki', () => ({
  highlightCode: vi.fn(() => null),
  initHighlighter: vi.fn().mockResolvedValue(undefined),
}));

describe('MarkdownContent', () => {
  it('renders bold and italic text', () => {
    render(<MarkdownContent content="**bold** and *italic*" />);
    const container = screen.getByText('bold').closest('.markdown-content')!;
    expect(container.querySelector('strong')).toHaveTextContent('bold');
    expect(container.querySelector('em')).toHaveTextContent('italic');
  });

  it('renders links with target="_blank" and rel="noopener noreferrer"', () => {
    render(<MarkdownContent content="[example](https://example.com)" />);
    const link = screen.getByText('example') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('href')).toBe('https://example.com');
  });

  it('neutralizes javascript: URLs', () => {
    render(<MarkdownContent content="[click](javascript:alert(1))" />);
    const link = screen.getByText('click') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#');
  });

  it('renders GFM tables', () => {
    const table = '| A | B |\n|---|---|\n| 1 | 2 |';
    const { container } = render(<MarkdownContent content={table} />);
    expect(container.querySelector('table')).toBeInTheDocument();
    expect(container.querySelector('th')).toHaveTextContent('A');
    expect(container.querySelectorAll('td')).toHaveLength(2);
  });

  it('renders code blocks', () => {
    const code = '```js\nconst x = 1;\n```';
    const { container } = render(<MarkdownContent content={code} />);
    expect(container.querySelector('pre')).toBeInTheDocument();
    expect(container.querySelector('code')).toHaveTextContent('const x = 1;');
  });

  it('renders line breaks with breaks: true', () => {
    const { container } = render(<MarkdownContent content={'line1\nline2'} />);
    expect(container.querySelector('br')).toBeInTheDocument();
  });

  it('renders empty content as empty div', () => {
    const { container } = render(<MarkdownContent content="" />);
    const div = container.querySelector('.markdown-content')!;
    expect(div).toBeInTheDocument();
    expect(div.innerHTML).toBe('');
  });

  it('renders correctly with isStreaming prop', () => {
    render(<MarkdownContent content="**streaming** content" isStreaming />);
    expect(screen.getByText('streaming')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(<MarkdownContent content="test" className="custom-class" />);
    expect(container.querySelector('.markdown-content.custom-class')).toBeInTheDocument();
  });

  it('memoizes parsed output for same content', () => {
    const { rerender, container } = render(<MarkdownContent content="**hello**" />);
    const firstHtml = container.querySelector('.markdown-content')!.innerHTML;

    rerender(<MarkdownContent content="**hello**" />);
    const secondHtml = container.querySelector('.markdown-content')!.innerHTML;

    expect(firstHtml).toBe(secondHtml);
  });

  it('renders images with lazy loading', () => {
    const { container } = render(
      <MarkdownContent content="![alt text](https://example.com/img.png)" />
    );
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('alt')).toBe('alt text');
  });

  it('renders nested lists', () => {
    const md = '- item 1\n  - nested 1\n  - nested 2\n- item 2';
    const { container } = render(<MarkdownContent content={md} />);
    const lists = container.querySelectorAll('ul');
    expect(lists.length).toBeGreaterThanOrEqual(2);
  });

  it('renders blockquotes', () => {
    const { container } = render(<MarkdownContent content="> a quote" />);
    expect(container.querySelector('blockquote')).toBeInTheDocument();
  });
});

describe('MarkdownContent — syntax highlighting', () => {
  const SHIKI_HTML =
    '<pre class="shiki one-dark-pro" style="background-color:#282c34;color:#abb2bf"><code><span style="color:#c678dd">const</span><span style="color:#e5c07b"> x</span><span style="color:#56b6c2"> =</span><span style="color:#d19a66"> 1</span><span style="color:#abb2bf">;</span></code></pre>';

  beforeEach(() => {
    vi.mocked(shikiLib.highlightCode).mockReset();
    vi.mocked(shikiLib.highlightCode).mockReturnValue(null);
  });

  it('renders Shiki output when highlighter is loaded and language is known', () => {
    vi.mocked(shikiLib.highlightCode).mockReturnValueOnce(SHIKI_HTML);
    const { container } = render(<MarkdownContent content={'```typescript\nconst x = 1;\n```'} />);
    const pre = container.querySelector('pre');
    expect(pre).toBeInTheDocument();
    expect(container.querySelector('span[style]')).toBeInTheDocument();
  });

  it('adds data-lang attribute to Shiki pre element', () => {
    vi.mocked(shikiLib.highlightCode).mockReturnValueOnce(SHIKI_HTML);
    const { container } = render(<MarkdownContent content={'```typescript\nconst x = 1;\n```'} />);
    const pre = container.querySelector('pre');
    expect(pre?.getAttribute('data-lang')).toBe('typescript');
  });

  it('falls back to plain code block when language is unknown', () => {
    vi.mocked(shikiLib.highlightCode).mockReturnValueOnce(null);
    const { container } = render(<MarkdownContent content={'```unknownlang\nfoo()\n```'} />);
    expect(container.querySelector('pre')).toBeInTheDocument();
    expect(container.querySelector('pre > code')).toBeInTheDocument();
    expect(container.querySelector('span[style]')).not.toBeInTheDocument();
  });

  it('renders plain code block when no language is specified', () => {
    const { container } = render(<MarkdownContent content={'```\nplain code\n```'} />);
    expect(container.querySelector('pre')).toBeInTheDocument();
    expect(container.querySelector('pre > code')).toBeInTheDocument();
    expect(container.querySelector('span[style]')).not.toBeInTheDocument();
  });

  it('falls back gracefully when Shiki highlighter is not yet loaded', () => {
    vi.mocked(shikiLib.highlightCode).mockReturnValueOnce(null);
    const { container } = render(<MarkdownContent content={'```typescript\nconst x = 1;\n```'} />);
    expect(container.querySelector('pre')).toBeInTheDocument();
    expect(container.querySelector('code')).toHaveTextContent('const x = 1;');
  });

  it('adds data-lang attribute to fallback pre for language badge', () => {
    const { container } = render(<MarkdownContent content={'```python\nprint("hello")\n```'} />);
    const pre = container.querySelector('pre');
    expect(pre?.getAttribute('data-lang')).toBe('python');
  });
});

describe('MarkdownContent — copy code button', () => {
  beforeEach(() => {
    vi.mocked(shikiLib.highlightCode).mockReset();
    vi.mocked(shikiLib.highlightCode).mockReturnValue(null);

    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
      configurable: true,
      writable: true,
    });
  });

  it('injects a copy button into each code block', () => {
    const { container } = render(<MarkdownContent content={'```js\nconst x = 1;\n```'} />);
    const btn = container.querySelector('.copy-code-btn');
    expect(btn).toBeInTheDocument();
  });

  it('does not inject a copy button during streaming', () => {
    const { container } = render(
      <MarkdownContent content={'```js\nconst x = 1;\n```'} isStreaming />
    );
    expect(container.querySelector('.copy-code-btn')).not.toBeInTheDocument();
  });

  it('does not inject copy button for inline code', () => {
    const { container } = render(<MarkdownContent content={'use `inline` code here'} />);
    expect(container.querySelector('code')).toBeInTheDocument();
    expect(container.querySelector('.copy-code-btn')).not.toBeInTheDocument();
  });

  it('injects one copy button per code block', () => {
    const md = '```js\nfoo()\n```\n\n```ts\nbar()\n```';
    const { container } = render(<MarkdownContent content={md} />);
    const pres = container.querySelectorAll('pre');
    const btns = container.querySelectorAll('.copy-code-btn');
    expect(btns).toHaveLength(pres.length);
  });

  it('calls clipboard.writeText with code text on click', async () => {
    const { container } = render(<MarkdownContent content={'```js\nconst x = 1;\n```'} />);
    const btn = container.querySelector('.copy-code-btn') as HTMLButtonElement;
    btn.click();
    await vi.waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const x = 1;');
    });
  });

  it('adds copied class to button after successful copy', async () => {
    const { container } = render(<MarkdownContent content={'```js\nconst x = 1;\n```'} />);
    const btn = container.querySelector('.copy-code-btn') as HTMLButtonElement;
    btn.click();
    await vi.waitFor(() => {
      expect(btn.classList.contains('copy-code-btn--copied')).toBe(true);
    });
  });

  it('reverts button state after 2 seconds', async () => {
    vi.useFakeTimers();
    const { container } = render(<MarkdownContent content={'```js\nconst x = 1;\n```'} />);
    const btn = container.querySelector('.copy-code-btn') as HTMLButtonElement;
    btn.click();
    await vi.waitFor(() => expect(btn.classList.contains('copy-code-btn--copied')).toBe(true));
    vi.advanceTimersByTime(2000);
    expect(btn.classList.contains('copy-code-btn--copied')).toBe(false);
    vi.useRealTimers();
  });
});
