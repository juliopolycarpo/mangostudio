import { afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';

import {
  groupedLinesHtml,
  HIGHLIGHT_FIRST_SLICE_MS,
  HIGHLIGHT_GROUP_CLASS,
  isGroupedBlock,
} from '@/lib/highlight-slices';
import {
  initHighlighter,
  observeTokenizedLines,
  preloadCodeLanguages,
  releaseHighlightSessions,
  setTimeStopClock,
} from '@/lib/shiki';
import { createCheckedRenderers } from '@/lib/shiki-checked-render';

import { stubClipboard } from '../../support/harness/clipboard';
import { pinTokenizerClockPerTest } from '../../support/harness/pinned-tokenizer-clock';
import { flushAsyncRender, render, waitFor } from '../../support/harness/render';
import { FakeIdleScheduler } from '../../support/mocks/fake-idle-scheduler';
import { SteppingClock } from '../../support/mocks/fake-stepping-clock';
import {
  frozenTokenizerClock,
  withTokenizerClock,
  withTokenizerClockAsync,
} from '../../support/mocks/fake-tokenizer-clock';

const { MarkdownContentRenderer } = await import('../../../src/components/MarkdownContentRenderer');

const THEME = 'one-dark-pro';
/** Lines tokenized between two clock reads: the unit a time budget is spent in. */
const BATCH_LINES = 16;
const CLOCK_STEP_MS = 10;
/** Tokenizer clock advance per read that stands for a slow machine; a line needs hundreds to pass 500 ms. */
const SLOW_MACHINE_READ_MS = 1;
/** At 10 ms per clock read the first draw spends its budget after ceil(budget / 10) batches. */
const FIRST_DRAW_LINES = BATCH_LINES * Math.ceil(HIGHLIGHT_FIRST_SLICE_MS / CLOCK_STEP_MS);

let highlighter: Awaited<ReturnType<typeof initHighlighter>>;
let idle: FakeIdleScheduler | undefined;
let restore: (() => void) | undefined;

beforeAll(async () => {
  await preloadCodeLanguages(['ts'], THEME);
  highlighter = await initHighlighter();
  // The grammar compiles a rule's regexes on the first line that reaches it. Warm every construct
  // the blocks below use (template strings, block comments, functions) under a frozen clock, so a
  // slow runner cannot spend the tokenizer's 500 ms limit on a compile and draw the block plain.
  withTokenizerClock(frozenTokenizerClock, () => {
    highlighter.codeToHtml(typescriptSource('warm', 1), { lang: 'typescript', theme: THEME });
  });
});

// None of these tests is about real time; the slow-machine one scripts its own clock.
pinTokenizerClockPerTest();

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
  const lines = renderers.tokenLinesToHtml(tokens, options);
  const holder = document.createElement('div');
  holder.innerHTML = renderers.htmlFromLines(
    isGroupedBlock(lines.length) ? [groupedLinesHtml(lines)] : lines,
    options
  );
  return holder.querySelector('code')?.innerHTML ?? '';
}

/** The `<code>` markup of `source` with its lines flat, whatever grouping the block gets on screen. */
function flatCodeHtml(source: string): string {
  const renderers = createCheckedRenderers(highlighter);
  const options = { lang: 'typescript', theme: THEME };
  const tokens = renderers.codeToTokensBase(source, { ...options, tokenizeTimeLimit: 500 });
  const holder = document.createElement('div');
  holder.innerHTML = renderers.htmlFromLines(renderers.tokenLinesToHtml(tokens, options), options);
  return holder.querySelector('code')?.innerHTML ?? '';
}

/** Empty lines in `source` from line `from` up to `to`: Shiki draws them with no token, so none is coloured. */
function blankLinesIn(source: string, from: number, to: number): number {
  return source
    .split('\n')
    .slice(from, to)
    .filter((line) => line === '').length;
}

function colouredLines(code: HTMLElement): number {
  return [...code.querySelectorAll('.line')].filter((line) =>
    line.querySelector('span[style*="color"]')
  ).length;
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

  it('still colours the first lines at once on a machine 20 times slower', async () => {
    // Regression for #2429: on a slow macOS runner a rule compiled inside the test passed the
    // tokenizer's 500 ms limit, the first draw stopped, and the block stayed plain.
    installIdleScheduler();
    useTenMillisecondClock();
    const source = typescriptSource('slowRunner', 20);

    // The slowness is scripted, not measured: every read of the tokenizer clock is 1 ms later, which
    // is a warm match on a machine about 20 times slower than a fast one. A line stays far under the
    // 500 ms limit, whatever speed the runner really has.
    const { container } = await withTokenizerClockAsync(
      new SteppingClock(SLOW_MACHINE_READ_MS).now,
      async () => {
        const rendered = render(<MarkdownContentRenderer content={fence(source)} />);
        await settleFirstDraw();
        return rendered;
      }
    );

    expect(colouredLines(codeOf(container)), 'coloured lines after the first draw').toBeGreaterThan(
      0
    );
  });

  it('writes each slice into the block alone and leaves the rest of the message untouched', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    const content = `Before the block.\n\n${fence(typescriptSource('aloneInMessage', 20))}\n\nAfter the block.`;
    const { container } = render(<MarkdownContentRenderer content={content} />);
    await settleFirstDraw();
    const paragraphs = [...container.querySelectorAll('p')];
    const pre = container.querySelector('pre');
    const firstLine = codeOf(container).querySelector('.line');
    expect(paragraphs, 'paragraphs in the message').toHaveLength(2);

    await scheduler.runIdle();
    await scheduler.runIdle();

    expect([...container.querySelectorAll('p')], 'paragraph nodes after two slices').toEqual(
      paragraphs
    );
    expect(container.querySelector('pre'), 'pre node after two slices').toBe(pre);
    expect(codeOf(container).querySelector('.line'), 'first line, coloured by the first draw').toBe(
      firstLine
    );
  });

  it('draws a long block in groups and a slice swaps lines only inside the groups it reaches', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    const source = typescriptSource('groupsTouched', 20);
    const { container } = render(<MarkdownContentRenderer content={fence(source)} />);
    await settleFirstDraw();
    const groups = [...codeOf(container).children];
    const firstDrawGroups = FIRST_DRAW_LINES / BATCH_LINES;
    expect(
      groups.every((group) => group.classList.contains(HIGHLIGHT_GROUP_CLASS)),
      'children of <code> that are groups'
    ).toBe(true);
    expect(groups[0]?.children, 'lines in the first group').toHaveLength(BATCH_LINES);

    await scheduler.runIdle();

    // The slice that follows the first draw reaches the group after the drawn ones.
    const after = [...codeOf(container).children];
    expect(after, 'group nodes after one slice').toHaveLength(groups.length);
    expect(after[0], 'first group, coloured by the first draw').toBe(groups[0]);
    expect(after[firstDrawGroups - 1], 'last group of the first draw').toBe(
      groups[firstDrawGroups - 1]
    );
    expect(after.at(-1), 'last group, not reached yet').toBe(groups.at(-1));
    expect(after[firstDrawGroups], 'group the slice reached').toBe(groups[firstDrawGroups]);
    expect(
      colouredLines(after[firstDrawGroups] as HTMLElement),
      'coloured lines in that group'
    ).toBe(BATCH_LINES - blankLinesIn(source, FIRST_DRAW_LINES, FIRST_DRAW_LINES + BATCH_LINES));
  });

  it('keeps a long block the same text as the flat block, and a short one flat', async () => {
    installIdleScheduler();
    useTenMillisecondClock();
    const longSource = typescriptSource('longText', 20);
    const shortSource = typescriptSource('shortText', 3);
    const long = render(<MarkdownContentRenderer content={fence(longSource)} />);
    const short = render(<MarkdownContentRenderer content={fence(shortSource)} />);
    await settleFirstDraw();

    expect(codeOf(long.container).textContent, 'text of the long block').toBe(longSource);
    expect(codeOf(short.container).innerHTML, 'markup of the short block').toBe(
      flatCodeHtml(shortSource)
    );
    expect(
      codeOf(short.container).querySelector(`.${HIGHLIGHT_GROUP_CLASS}`),
      'group in the short block'
    ).toBeNull();
  });

  it('copies the whole source from the copy button while the block is half coloured and once it is done', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    const copied: string[] = [];
    stubClipboard((text) => {
      copied.push(text);
      return Promise.resolve();
    });
    const source = typescriptSource('copyWhole', 20);
    const { container } = render(<MarkdownContentRenderer content={fence(source)} />);
    await settleFirstDraw();
    const button = container.querySelector<HTMLButtonElement>('.copy-code-btn');

    button?.click();
    await waitFor(() => expect(copied).toHaveLength(1));
    for (let guard = 0; guard < 50 && scheduler.pending > 0; guard++) await scheduler.runIdle();
    button?.click();
    await waitFor(() => expect(copied).toHaveLength(2));

    expect(copied, 'texts written to the clipboard').toEqual([source, source]);
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

/** Runs idle callbacks until none wait (100 rounds at most), then lets the final redraw land. */
async function runSlicesToTheEnd(scheduler: FakeIdleScheduler): Promise<void> {
  for (let guard = 0; guard < 100 && scheduler.pending > 0; guard++) await scheduler.runIdle();
  await settleFirstDraw();
}

function codeBlocksOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('pre[data-lang="typescript"] code')];
}

describe('identical blocks share one highlighting session', () => {
  it('colours both blocks when the same fence is in a message twice', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    const source = typescriptSource('fenceTwice', 20);
    const content = `${fence(source)}\n\nBetween the two.\n\n${fence(source)}`;
    const { container } = render(<MarkdownContentRenderer content={content} />);
    await settleFirstDraw();

    await runSlicesToTheEnd(scheduler);

    const blocks = codeBlocksOf(container);
    expect(blocks, 'code blocks in the message').toHaveLength(2);
    for (const [index, block] of blocks.entries()) {
      expect(block.innerHTML, `markup of block ${index}`).toBe(oneShotCodeHtml(source));
    }
  });

  it('colours the same block in two mounted messages, whatever order their slices run in', async () => {
    const scheduler = installIdleScheduler();
    useTenMillisecondClock();
    const source = typescriptSource('twoMounts', 20);
    const first = render(<MarkdownContentRenderer content={fence(source)} />);
    const second = render(<MarkdownContentRenderer content={fence(source)} />);
    await settleFirstDraw();
    // Both loops wait, and the second draw left the shared session ahead of the first's block.
    expect(scheduler.pending, 'slice loops waiting').toBe(2);

    await runSlicesToTheEnd(scheduler);

    expect(codeOf(first.container).innerHTML, 'markup of the first message').toBe(
      oneShotCodeHtml(source)
    );
    expect(codeOf(second.container).innerHTML, 'markup of the second message').toBe(
      oneShotCodeHtml(source)
    );
  });
});
