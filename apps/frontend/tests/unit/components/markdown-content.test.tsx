import { describe, expect, it } from 'vitest';
import { render, screen } from '../../support/harness/render';
import { MarkdownContent } from '../../../src/components/MarkdownContent';

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
