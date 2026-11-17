import { afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';

import { HIGHLIGHT_FIRST_SLICE_MS } from '@/lib/highlight-slices';
import {
  initHighlighter,
  observeTokenizedLines,
  preloadCodeLanguages,
  releaseHighlightSessions,
  setTimeStopClock,
} from '@/lib/shiki';
import { createCheckedRenderers } from '@/lib/shiki-checked-render';

import { flushAsyncRender, render } from '../../support/harness/render';
import { FakeIdleScheduler } from '../../support/mocks/fake-idle-scheduler';
import { SteppingClock } from '../../support/mocks/fake-stepping-clock';
import { frozenTokenizerClock, withTokenizerClock } from '../../support/mocks/fake-tokenizer-clock';

const { MarkdownContentRenderer } = await import('../../../src/components/MarkdownContentRenderer');

const THEME = 'one-dark-pro';
/** Lines tokenized between two clock reads: the unit a time budget is spent in. */
const BATCH_LINES = 16;
const CLOCK_STEP_MS = 10;
/** At 10 ms per clock read the first draw spends its budget after ceil(budget / 10) batches. */
const FIRST_DRAW_LINES = BATCH_LINES * Math.ceil(HIGHLIGHT_FIRST_SLICE_MS / CLOCK_STEP_MS);

let highlighter: Awaited<ReturnType<typeof initHighlighter>>;
let idle: FakeIdleScheduler | undefined;
let restore: (() => void) | undefined;

beforeAll(async () => {
  await preloadCodeLanguages(['ts'], THEME);
  highlighter = await initHighlighter();
  withTokenizerClock(frozenTokenizerClock, () => {
    highlighter.codeToHtml('const value = 42;', { lang: 'typescript', theme: THEME });
  });
});

afterEach(() => {
  setTimeStopClock(null);
  observeTokenizedLines(null);
  restore?.();
  restore = undefined;
  idle?.restore();
  idle = undefined;
});

/** Multi-line constructs, so a wrong carried state shows as wrong colours. */
function typescriptSource(label: string, repeats: number): string {
  return Array.from({ length: repeats }, () =>
    [
      `const ${label} = 1;`,
      'const text = `first',
      `second \${${label} + 1}`,
      'third`;',
      '/* a comment',
      '   over lines */',
      `function ${label}(x: number): string {`,
      `  return \`\${x}\`;`,
      '}',
      '',
    ].join('\n')
  ).join('\n');
}

function fence(source: string): string {
  return `\`\`\`typescript\n${source}\n\`\`\``;
}

function installIdleScheduler(): FakeIdleScheduler {
  idle = new FakeIdleScheduler().install();
  return idle;
}

/** Every read of the slice clock is 10 ms later, so a budget is spent after a known number of batches. */
function useTenMillisecondClock(): void {
  setTimeStopClock(new SteppingClock(CLOCK_STEP_MS).now);
}

function codeOf(container: HTMLElement): HTMLElement {
  const code = container.querySelector<HTMLElement>('pre[data-lang="typescript"] code');
  if (!code) throw new Error('(markdown): expected a typescript code block, received none');
  return code;
}

/** The `<code>` markup Shiki writes for `source` when it tokenizes the whole block at once. */
function oneShotCodeHtml(source: string): string {
  const renderers = createCheckedRenderers(highlighter);
  const options = { lang: 'typescript', theme: THEME };
  const tokens = renderers.codeToTokensBase(source, { ...options, tokenizeTimeLimit: 500 });
  const holder = document.createElement('div');
  holder.innerHTML = renderers.htmlFromLines(renderers.tokenLinesToHtml(tokens, options), options);
  return holder.querySelector('code')?.innerHTML ?? '';
}

function colouredLines(code: HTMLElement): number {
  return [...code.children].filter((line) => line.querySelector('span[style*="color"]')).length;
}

async function settleFirstDraw(): Promise<void> {
  await flushAsyncRender();
  await flushAsyncRender();
}

/** Stops the tokenizer on the listed calls (1-based, one call per line) and lets the others finish. */
class GrammarStopsOnCalls {
  calls = 0;

  constructor(private readonly stopOn: readonly number[]) {}

  install(): this {
    const grammar = highlighter.getLanguage('typescript');
    const original = grammar.tokenizeLine2;
    const tokenizer = spyOn(grammar, 'tokenizeLine2').mockImplementation(
      (...args: Parameters<typeof original>) => {
        this.calls++;
        return { ...original.apply(grammar, args), stoppedEarly: this.stopOn.includes(this.calls) };
      }
    );
    restore = () => tokenizer.mockRestore();
    return this;
  }
}

describe('a large code block drawn in slices', () => {
  it('colours the first lines at once and the rest in idle slices, ending as a whole-block draw', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    const source = typescriptSource('sliceFinal', 20);
    const { container } = render(<MarkdownContentRenderer content={fence(source)} />);
    await settleFirstDraw();

    const code = codeOf(container);
    expect(colouredLines(code), 'coloured lines after the first draw').toBeLessThan(
      FIRST_DRAW_LINES
    );
    expect(colouredLines(code), 'coloured lines after the first draw').toBeGreaterThan(0);
    expect(scheduler.pending, 'slices waiting for an idle moment').toBe(1);

    for (let guard = 0; guard < 50 && scheduler.pending > 0; guard++) await scheduler.runIdle();

    expect(codeOf(container).innerHTML, 'block markup once every slice has landed').toBe(
      oneShotCodeHtml(source)
    );
    expect(code.isConnected, 'the code element the first draw made').toBe(true);
  });

  it('writes each slice into the block alone and leaves the rest of the message untouched', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    const content = `Before the block.\n\n${fence(typescriptSource('aloneInMessage', 20))}\n\nAfter the block.`;
    const { container } = render(<MarkdownContentRenderer content={content} />);
    await settleFirstDraw();
    const paragraphs = [...container.querySelectorAll('p')];
    const pre = container.querySelector('pre');
    const firstLine = codeOf(container).children[0];
    expect(paragraphs, 'paragraphs in the message').toHaveLength(2);

    await scheduler.runIdle();
    await scheduler.runIdle();

    expect([...container.querySelectorAll('p')], 'paragraph nodes after two slices').toEqual(
      paragraphs
    );
    expect(container.querySelector('pre'), 'pre node after two slices').toBe(pre);
    expect(codeOf(container).children[0], 'first line, coloured by the first draw').toBe(firstLine);
  });

  it('does not tokenize a line twice', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    const tokenized: string[] = [];
    observeTokenizedLines((line) => tokenized.push(line));
    const source = typescriptSource('once', 20);
    render(<MarkdownContentRenderer content={fence(source)} />);
    await settleFirstDraw();
    for (let guard = 0; guard < 50 && scheduler.pending > 0; guard++) await scheduler.runIdle();

    // Every line once, and the open last line once more when the block is finished.
    expect(tokenized.length, 'lines tokenized over the whole block').toBeLessThanOrEqual(
      source.split('\n').length + 1
    );
  });

  it('is a plain block with no slices when the tokenizer stopped the first draw', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    const grammar = new GrammarStopsOnCalls([1, 2]).install();
    const source = typescriptSource('stopsFirstDraw', 20);
    const { container } = render(<MarkdownContentRenderer content={fence(source)} />);
    await settleFirstDraw();
    // The existing retry owns this block: one callback, which stops again and leaves it plain.
    await scheduler.runIdle();
    await settleFirstDraw();

    expect(grammar.calls, 'tokenize attempts for a block that stops twice').toBe(2);
    expect(container.querySelector('pre[data-lang="typescript"]'), 'pre').not.toHaveClass('shiki');
    expect(codeOf(container).textContent).toBe(source);
    expect(scheduler.pending, 'slices scheduled for a plain block').toBe(0);
  });

  it('keeps the source text whole at every step', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    const source = typescriptSource('textWhole', 20);
    const { container } = render(<MarkdownContentRenderer content={fence(source)} />);
    await settleFirstDraw();

    expect(codeOf(container).textContent, 'text after the first draw').toBe(source);
    await scheduler.runIdle();
    expect(codeOf(container).textContent, 'text after one slice').toBe(source);
  });
});

describe('a slice the tokenizer stops on its time limit', () => {
  it('is asked once more after an idle yield, and the block is then coloured to the end', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    // The first draw tokenizes lines 1-96; the next call (97) is the first line of the first slice.
    const grammar = new GrammarStopsOnCalls([FIRST_DRAW_LINES + 1]).install();
    const source = typescriptSource('retriedSlice', 20);
    const { container } = render(<MarkdownContentRenderer content={fence(source)} />);
    await settleFirstDraw();
    const colouredByFirstDraw = colouredLines(codeOf(container));

    await scheduler.runIdle();
    expect(colouredLines(codeOf(container)), 'coloured lines after the stopped slice').toBe(
      colouredByFirstDraw
    );
    expect(scheduler.pending, 'slices waiting after a stop').toBe(1);

    for (let guard = 0; guard < 50 && scheduler.pending > 0; guard++) await scheduler.runIdle();

    expect(grammar.calls, 'tokenizer calls in all').toBeGreaterThan(FIRST_DRAW_LINES + 1);
    expect(codeOf(container).innerHTML, 'block markup after the retry').toBe(
      oneShotCodeHtml(source)
    );
  });

  it('stops slicing after a second stop, and the lines not reached stay plain text', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    // The first slice stops on its first line, and so does its retry.
    new GrammarStopsOnCalls([FIRST_DRAW_LINES + 1, FIRST_DRAW_LINES + 2]).install();
    const source = typescriptSource('stopsTwice', 20);
    const { container } = render(<MarkdownContentRenderer content={fence(source)} />);
    await settleFirstDraw();
    const colouredByFirstDraw = colouredLines(codeOf(container));

    await scheduler.runIdle();
    await scheduler.runIdle();
    await settleFirstDraw();

    expect(scheduler.pending, 'slices waiting after two stops').toBe(0);
    expect(colouredLines(codeOf(container)), 'coloured lines after two stops').toBe(
      colouredByFirstDraw
    );
    expect(codeOf(container).textContent, 'text after two stops').toBe(source);
  });
});

describe('slices and a change to the block', () => {
  it('cancels the pending slice on unmount', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    const { unmount } = render(
      <MarkdownContentRenderer content={fence(typescriptSource('unmounted', 20))} />
    );
    await settleFirstDraw();
    expect(scheduler.pending, 'slices waiting before unmount').toBe(1);

    unmount();

    expect(scheduler.pending, 'slices waiting after unmount').toBe(0);
  });

  it('cancels the pending slice when the content changes, and slices the new block', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    const tokenized: string[] = [];
    const first = typescriptSource('beforeChange', 20);
    const second = typescriptSource('afterChange', 20);
    const { container, rerender } = render(<MarkdownContentRenderer content={fence(first)} />);
    await settleFirstDraw();
    observeTokenizedLines((line) => tokenized.push(line));

    rerender(<MarkdownContentRenderer content={fence(second)} />);
    await settleFirstDraw();
    for (let guard = 0; guard < 50 && scheduler.pending > 0; guard++) await scheduler.runIdle();

    expect(
      tokenized.filter((line) => line.includes('beforeChange')),
      'lines of the replaced block tokenized after the change'
    ).toEqual([]);
    expect(codeOf(container).innerHTML, 'block markup of the new content').toBe(
      oneShotCodeHtml(second)
    );
  });

  it('does not slice while the message streams, and finishes the block when the stream ends', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    const source = typescriptSource('streamed', 20);
    const { container, rerender } = render(
      <MarkdownContentRenderer content={fence(source)} isStreaming />
    );
    await settleFirstDraw();

    expect(scheduler.pending, 'slices waiting while streaming').toBe(0);

    rerender(<MarkdownContentRenderer content={fence(source)} />);
    await settleFirstDraw();
    for (let guard = 0; guard < 50 && scheduler.pending > 0; guard++) await scheduler.runIdle();

    expect(codeOf(container).innerHTML, 'block markup after the stream ended').toBe(
      oneShotCodeHtml(source)
    );
  });

  it('draws a finished block from the cache when it is mounted again', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    const source = typescriptSource('remounted', 20);
    const first = render(<MarkdownContentRenderer content={fence(source)} />);
    await settleFirstDraw();
    for (let guard = 0; guard < 50 && scheduler.pending > 0; guard++) await scheduler.runIdle();
    first.unmount();
    releaseHighlightSessions();
    const tokenized: string[] = [];
    observeTokenizedLines((line) => tokenized.push(line));

    const second = render(<MarkdownContentRenderer content={fence(source)} />);
    await settleFirstDraw();

    expect(scheduler.pending, 'slices waiting for a block that is cached').toBe(0);
    expect(tokenized, 'lines tokenized by the remount').toEqual([]);
    expect(codeOf(second.container).innerHTML, 'block markup after the remount').toBe(
      oneShotCodeHtml(source)
    );
  });
});
