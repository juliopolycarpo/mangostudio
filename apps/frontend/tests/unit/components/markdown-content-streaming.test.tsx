import { beforeEach, describe, expect, it, jest, mock } from 'bun:test';

import { render, waitFor } from '../../support/harness/render';

// A named fake in place of the Shiki chunk: it colours any fenced block and counts how often
// each block's source is handed to it, which is how a re-rendered block shows up.
const highlighted: string[] = [];
const fakeHighlighter = {
  highlightCode: jest.fn((code: string) => {
    highlighted.push(code);
    return `<pre class="shiki"><code>${code.replaceAll('<', '&lt;')}</code></pre>`;
  }),
  initHighlighter: jest.fn(() => Promise.resolve(undefined)),
  preloadCodeLanguages: jest.fn(() => Promise.resolve(true)),
};

void mock.module('@/lib/shiki', () => ({
  ...fakeHighlighter,
  CODE_THEMES: ['one-dark-pro', 'github-dark-dimmed', 'github-light', 'one-light'],
}));

const { MarkdownContentRenderer } = await import('../../../src/components/MarkdownContentRenderer');

/** The renderer's own output for `content`, from a fresh mount: what today's whole-message render gives. */
function fromScratchHtml(content: string): string {
  const { container, unmount } = render(<MarkdownContentRenderer content={content} />);
  const html = container.querySelector('.markdown-content')?.innerHTML ?? '';
  unmount();
  return html;
}

/** The value, or a failure that names what was missing. */
function found<Value>(value: Value | null | undefined, description: string): Value {
  if (value === null || value === undefined) {
    throw new Error(`expected ${description} in the rendered output | received: ${String(value)}`);
  }
  return value;
}

function chunksOf(text: string, size: number): string[] {
  const prefixes: string[] = [];
  for (let end = size; end < text.length + size; end += size) prefixes.push(text.slice(0, end));
  return prefixes;
}

describe('MarkdownContentRenderer while a message streams', () => {
  beforeEach(() => {
    highlighted.length = 0;
  });

  it('leaves the DOM nodes of settled blocks alone when a chunk lands in the last block', () => {
    const settled = '# Title\n\nfirst paragraph\n\n- one\n- two\n\n';
    const { container, rerender } = render(
      <MarkdownContentRenderer content={`${settled}live`} isStreaming />
    );
    const root = found(container.querySelector('.markdown-content'), '.markdown-content');
    const settledNodes = [...root.children].slice(0, 3);
    expect(settledNodes.map((node) => node.tagName)).toEqual(['H1', 'P', 'UL']);

    for (const tail of ['live t', 'live tail', 'live tail goes on\n\nnext']) {
      rerender(<MarkdownContentRenderer content={`${settled}${tail}`} isStreaming />);
    }

    expect([...root.children].slice(0, 3)).toEqual(settledNodes);
    expect(root.lastElementChild).toHaveTextContent('next');
  });

  it('keeps a selection inside a settled block while later blocks stream in', () => {
    const settled = 'select this sentence\n\n';
    const { container, rerender } = render(
      <MarkdownContentRenderer content={`${settled}a`} isStreaming />
    );
    const paragraphText = found(container.querySelector('p')?.firstChild, 'a paragraph text node');
    const range = document.createRange();
    range.setStart(paragraphText, 7);
    range.setEnd(paragraphText, 11);
    const selection = found(window.getSelection(), 'a window selection');
    selection.removeAllRanges();
    selection.addRange(range);

    rerender(<MarkdownContentRenderer content={`${settled}ab`} isStreaming />);
    rerender(<MarkdownContentRenderer content={`${settled}abc\n\nmore`} isStreaming />);

    expect(selection.toString()).toBe('this');
    expect(selection.getRangeAt(0).startContainer).toBe(paragraphText);
  });

  it('does not highlight a closed code block again for every chunk after it', async () => {
    const code = 'const answer = 42;\nconsole.log(answer);';
    const settled = `intro\n\n\`\`\`ts\n${code}\n\`\`\`\n\n`;
    const { rerender } = render(<MarkdownContentRenderer content={`${settled}t`} isStreaming />);
    // The grammar arrives asynchronously; the block is coloured once it has.
    await waitFor(() =>
      expect(highlighted.filter((source) => source === code).length).toBeGreaterThan(0)
    );
    const afterFirstRender = highlighted.filter((source) => source === code).length;

    for (let length = 2; length <= 40; length++) {
      rerender(<MarkdownContentRenderer content={`${settled}${'t'.repeat(length)}`} isStreaming />);
    }

    expect(highlighted.filter((source) => source === code)).toHaveLength(afterFirstRender);
  });

  it('keeps the copy button of a settled block, and the state it is in, across chunks', () => {
    const settled = '```ts\nlet a = 1;\n```\n\n';
    const { container, rerender } = render(
      <MarkdownContentRenderer content={`${settled}x`} isStreaming />
    );
    const button = found(container.querySelector('.copy-code-btn'), 'a copy button');
    button.classList.add('copy-code-btn--copied');

    rerender(<MarkdownContentRenderer content={`${settled}xy`} isStreaming />);

    expect(container.querySelector('.copy-code-btn')).toBe(button);
    expect(button).toHaveClass('copy-code-btn--copied');
  });

  it('ends a stream on the same markup a from-scratch render gives, at every chunk size', () => {
    const answer = [
      '# Plan',
      '',
      'Intro with **bold**, `code` and a [link][ref].',
      '',
      '1. first',
      '2. second',
      '   - nested',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '```ts',
      'const x = 1;',
      '',
      'const y = 2;',
      '```',
      '',
      '> quoted',
      'lazy',
      '',
      '[ref]: https://ref.example',
      '',
      'Done. 😀',
    ].join('\n');
    const expected = fromScratchHtml(answer);

    for (const size of [1, 3, 7, 50]) {
      const { container, rerender, unmount } = render(
        <MarkdownContentRenderer content="" isStreaming />
      );
      for (const prefix of chunksOf(answer, size)) {
        rerender(<MarkdownContentRenderer content={prefix} isStreaming />);
      }
      expect(container.querySelector('.markdown-content')?.innerHTML).toBe(expected);
      unmount();
    }
  });

  it('renders every prefix of a stream like a from-scratch render', () => {
    const answer = 'See [a][r].\n\n- x\n\n  y\n\n2\n\n```ts\ncode\n\n[r]: https://r.example\n';
    const { container, rerender } = render(<MarkdownContentRenderer content="" isStreaming />);
    for (const prefix of chunksOf(answer, 2)) {
      rerender(<MarkdownContentRenderer content={prefix} isStreaming />);
      expect(container.querySelector('.markdown-content')?.innerHTML).toBe(fromScratchHtml(prefix));
    }
  });

  it('empties the container when the content becomes empty and fills it again', () => {
    const { container, rerender } = render(<MarkdownContentRenderer content="hello" />);
    rerender(<MarkdownContentRenderer content="" />);
    expect(container.querySelector('.markdown-content')?.innerHTML).toBe('');

    rerender(<MarkdownContentRenderer content="again" />);
    expect(container.querySelector('.markdown-content')).toHaveTextContent('again');
  });
});

describe('MarkdownContentRenderer sanitization while a message streams', () => {
  const attack =
    'ok\n\n<img src=x onerror=alert(1)>\n\ntext <img src=x onerror=alert(2)> mid\n\n' +
    '[click](javascript:alert(3)) [x<img src=y onerror=alert(4)>](https://a.example)\n\n' +
    '![p](javascript:alert(5)) [r]\n\n[r]: javascript:alert(6)\n';

  it('never puts a live element, handler or script URL on the page, whatever the chunk boundaries', () => {
    for (let split = 1; split < attack.length; split += 3) {
      const { container, rerender, unmount } = render(
        <MarkdownContentRenderer content={attack.slice(0, split)} isStreaming />
      );
      rerender(<MarkdownContentRenderer content={attack.slice(0, split + 2)} isStreaming />);
      rerender(<MarkdownContentRenderer content={attack} isStreaming />);

      const root = found(container.querySelector('.markdown-content'), '.markdown-content');
      expect(root.querySelector('img, script, iframe')).toBeNull();
      for (const element of root.querySelectorAll('*')) {
        expect(element.getAttributeNames().filter((name) => name.startsWith('on'))).toEqual([]);
      }
      for (const anchor of root.querySelectorAll('a')) {
        expect(anchor.getAttribute('href')).not.toMatch(/^\s*javascript:/i);
      }
      expect(root.innerHTML).toBe(fromScratchHtml(attack));
      unmount();
    }
  });
});
