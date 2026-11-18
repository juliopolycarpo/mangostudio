import { afterEach, describe, expect, it } from 'bun:test';

import {
  colouredLinesIn,
  continueHighlightsInSlices,
  groupedLinesHtml,
  HIGHLIGHT_GROUP_CLASS,
  HIGHLIGHT_GROUP_LINES,
  HIGHLIGHT_SLICE_IDLE_TIMEOUT_MS,
  HIGHLIGHT_SLICE_MS,
  HIGHLIGHT_UNGROUPED_MAX_LINES,
  type HighlightSlice,
  isGroupedBlock,
  patchCodeLines,
  type SlicedBlock,
} from '@/lib/highlight-slices';

import { FakeIdleScheduler } from '../../support/mocks/fake-idle-scheduler';

let idle: FakeIdleScheduler | undefined;
const mounted: Element[] = [];

afterEach(() => {
  idle?.restore();
  idle = undefined;
  for (const element of mounted.splice(0)) element.remove();
});

function installIdle(): FakeIdleScheduler {
  idle = new FakeIdleScheduler().install();
  return idle;
}

/** A drawn block: a `<pre><code>` of `<span class="line">` elements, as the highlighter writes it. */
function drawBlock(lines: readonly string[]): HTMLPreElement {
  const pre = document.createElement('pre');
  const html = lines.map((text) => `<span class="line"><span>${text}</span></span>`).join('\n');
  pre.innerHTML = `<code>${html}</code><button class="copy-code-btn"></button>`;
  document.body.append(pre);
  mounted.push(pre);
  return pre;
}

function lineTexts(pre: Element): string[] {
  return [...(pre.querySelector('code')?.children ?? [])].map((line) => line.textContent ?? '');
}

function sliceOf(fromLine: number, texts: readonly string[], lineCount: number, done = false) {
  return {
    fromLine,
    lineHtml: texts.map((text) => `<span class="line"><b>${text}</b></span>`),
    lineCount,
    done,
  } satisfies HighlightSlice;
}

/** A block that answers with the slices it is given, one per `advance`, and records the budgets asked. */
class ScriptedBlock implements SlicedBlock {
  readonly budgets: number[] = [];
  /** The line the loop said its `<pre>` had reached, at each ask. */
  readonly fromLines: number[] = [];
  private next = 0;

  constructor(
    readonly pre: Element,
    private readonly answers: readonly (HighlightSlice | null)[],
    private readonly retriesAfterStop = false,
    private readonly pending = true
  ) {}

  advance = (budgetMs: number, fromLine: number): HighlightSlice | null => {
    this.budgets.push(budgetMs);
    this.fromLines.push(fromLine);
    return this.answers[this.next++] ?? null;
  };

  isPending = (): boolean => this.pending;

  canRetryAfterStop = (): boolean => this.retriesAfterStop;
}

/** A block drawn partly: the first `coloured` lines have styled tokens, the rest are plain text. */
function drawPartlyColouredBlock(texts: readonly string[], coloured: number): HTMLPreElement {
  const pre = document.createElement('pre');
  const lines = texts.map((text, index) =>
    index < coloured
      ? `<span class="line"><span style="color:#fff">${text}</span></span>`
      : `<span class="line"><span>${text}</span></span>`
  );
  pre.innerHTML = `<code>${lines.join('\n')}</code>`;
  document.body.append(pre);
  mounted.push(pre);
  return pre;
}

class RedrawCounter {
  calls = 0;
  redraw = (): void => {
    this.calls++;
  };
}

describe('patchCodeLines', () => {
  it('replaces only the lines of the slice and keeps every other node', () => {
    const pre = drawBlock(['a', 'b', 'c', 'd']);
    const code = pre.querySelector('code');
    const before = [...(code?.children ?? [])];

    const patched = patchCodeLines(pre, sliceOf(1, ['B', 'C'], 4));

    expect(patched).toBe(true);
    expect(lineTexts(pre), 'line texts after the patch').toEqual(['a', 'B', 'C', 'd']);
    const after = [...(code?.children ?? [])];
    expect(after[0], 'line before the slice is the same node').toBe(before[0]);
    expect(after[3], 'line after the slice is the same node').toBe(before[3]);
    expect(after[1], 'first patched line is a new node').not.toBe(before[1]);
    expect(pre.querySelector('.copy-code-btn'), 'copy button').not.toBeNull();
  });

  it('refuses a block that has left the page', () => {
    const pre = drawBlock(['a', 'b']);
    pre.remove();

    expect(patchCodeLines(pre, sliceOf(0, ['A'], 2))).toBe(false);
  });

  it('refuses a block drawn as plain text, which has no line elements', () => {
    const pre = document.createElement('pre');
    pre.innerHTML = '<code>a\nb</code>';
    document.body.append(pre);
    mounted.push(pre);

    expect(patchCodeLines(pre, sliceOf(0, ['A'], 2))).toBe(false);
    expect(pre.textContent).toBe('a\nb');
  });

  it('refuses a slice made for a block with another line count, and writes nothing', () => {
    const pre = drawBlock(['a', 'b', 'c']);

    expect(patchCodeLines(pre, sliceOf(0, ['A'], 5))).toBe(false);
    expect(lineTexts(pre), 'line texts after a refused patch').toEqual(['a', 'b', 'c']);
  });

  it('accepts an empty slice', () => {
    const pre = drawBlock(['a']);

    expect(patchCodeLines(pre, sliceOf(1, [], 1))).toBe(true);
  });
});

const LONG_BLOCK_LINES = HIGHLIGHT_UNGROUPED_MAX_LINES + 6;

function lineHtmlOf(text: string): string {
  return `<span class="line"><span>${text}</span></span>`;
}

function numberedLines(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line ${index}`);
}

/** A drawn long block: its lines in groups, as `highlightCode` writes it. */
function drawGroupedBlock(texts: readonly string[]): HTMLPreElement {
  const pre = document.createElement('pre');
  pre.innerHTML = `<code>${groupedLinesHtml(texts.map(lineHtmlOf))}</code>`;
  document.body.append(pre);
  mounted.push(pre);
  return pre;
}

function allLineTexts(pre: Element): string[] {
  return [...pre.querySelectorAll('.line')].map((line) => line.textContent ?? '');
}

describe('groupedLinesHtml', () => {
  it('puts the lines in groups of the group size, the last group with what is left', () => {
    const texts = numberedLines(LONG_BLOCK_LINES);
    const holder = document.createElement('code');
    holder.innerHTML = groupedLinesHtml(texts.map(lineHtmlOf));

    const groups = [...holder.children];
    expect(groups, 'groups for 70 lines').toHaveLength(
      Math.ceil(LONG_BLOCK_LINES / HIGHLIGHT_GROUP_LINES)
    );
    expect(
      groups.map((group) => group.className),
      'group classes'
    ).toEqual(groups.map(() => HIGHLIGHT_GROUP_CLASS));
    expect(
      groups.map((group) => group.children.length),
      'lines per group'
    ).toEqual([16, 16, 16, 16, LONG_BLOCK_LINES - 64]);
  });

  it('keeps the text of the flat block: a line break after every line but the last', () => {
    const texts = numberedLines(LONG_BLOCK_LINES);
    const holder = document.createElement('code');
    holder.innerHTML = groupedLinesHtml(texts.map(lineHtmlOf));

    expect(holder.textContent, 'text of the grouped block').toBe(texts.join('\n'));
    expect(holder.innerHTML.endsWith('\n</span>'), 'line break at the end of the block').toBe(
      false
    );
    expect(
      holder.children[0]?.textContent?.endsWith('\n'),
      'line break closing the first group'
    ).toBe(true);
  });

  it('draws a block over the limit in groups and a block at the limit flat', () => {
    expect(isGroupedBlock(HIGHLIGHT_UNGROUPED_MAX_LINES), 'lines at the limit').toBe(false);
    expect(isGroupedBlock(HIGHLIGHT_UNGROUPED_MAX_LINES + 1), 'lines over the limit').toBe(true);
  });
});

describe('patchCodeLines in a block of groups', () => {
  it('replaces lines across a group boundary and keeps every group node and every other line', () => {
    const texts = numberedLines(LONG_BLOCK_LINES);
    const pre = drawGroupedBlock(texts);
    const code = pre.querySelector('code');
    const groupsBefore = [...(code?.children ?? [])];
    const linesBefore = [...pre.querySelectorAll('.line')];
    const from = HIGHLIGHT_GROUP_LINES - 2;

    const patched = patchCodeLines(pre, sliceOf(from, ['A', 'B', 'C', 'D'], LONG_BLOCK_LINES));

    expect(patched).toBe(true);
    expect(allLineTexts(pre).slice(from - 1, from + 5), 'texts around the patch').toEqual([
      'line 13',
      'A',
      'B',
      'C',
      'D',
      'line 18',
    ]);
    expect([...(code?.children ?? [])], 'group nodes after the patch').toEqual(groupsBefore);
    const linesAfter = [...pre.querySelectorAll('.line')];
    expect(
      linesAfter.filter((line, index) => line !== linesBefore[index]).length,
      'lines that are new nodes'
    ).toBe(4);
    expect(code?.textContent?.split('\n'), 'line breaks of the block').toHaveLength(
      LONG_BLOCK_LINES
    );
  });

  it('patches the last line, which sits in the short last group', () => {
    const pre = drawGroupedBlock(numberedLines(LONG_BLOCK_LINES));

    const patched = patchCodeLines(pre, sliceOf(LONG_BLOCK_LINES - 1, ['last'], LONG_BLOCK_LINES));

    expect(patched).toBe(true);
    expect(allLineTexts(pre).at(-1), 'last line').toBe('last');
  });

  it('refuses a flat block for a slice of a long one, and writes nothing', () => {
    const pre = drawBlock(numberedLines(LONG_BLOCK_LINES));

    expect(patchCodeLines(pre, sliceOf(0, ['A'], LONG_BLOCK_LINES))).toBe(false);
    expect(lineTexts(pre)[0], 'first line after a refused patch').toBe('line 0');
  });

  it('refuses a block of groups for a slice of another line count', () => {
    const pre = drawGroupedBlock(numberedLines(LONG_BLOCK_LINES));

    expect(patchCodeLines(pre, sliceOf(0, ['A'], LONG_BLOCK_LINES + HIGHLIGHT_GROUP_LINES))).toBe(
      false
    );
    expect(allLineTexts(pre)[0], 'first line after a refused patch').toBe('line 0');
  });
});

describe('continueHighlightsInSlices', () => {
  it('runs one slice per idle callback and asks for a slice-sized budget', async () => {
    const scheduler = installIdle();
    const pre = drawBlock(['a', 'b', 'c', 'd']);
    const block = new ScriptedBlock(pre, [
      sliceOf(0, ['A'], 4),
      sliceOf(1, ['B'], 4),
      sliceOf(2, ['C', 'D'], 4, true),
    ]);
    const redraws = new RedrawCounter();
    continueHighlightsInSlices([block], redraws.redraw);

    expect(block.budgets, 'slices before an idle moment').toEqual([]);
    expect(scheduler.timeouts, 'idle timeouts requested').toEqual([
      HIGHLIGHT_SLICE_IDLE_TIMEOUT_MS,
    ]);

    await scheduler.runIdle();
    expect(lineTexts(pre), 'texts after one idle callback').toEqual(['A', 'b', 'c', 'd']);
    await scheduler.runIdle();
    await scheduler.runIdle();

    expect(lineTexts(pre), 'texts after the last slice').toEqual(['A', 'B', 'C', 'D']);
    expect(block.budgets, 'budgets asked').toEqual([
      HIGHLIGHT_SLICE_MS,
      HIGHLIGHT_SLICE_MS,
      HIGHLIGHT_SLICE_MS,
    ]);
    expect(scheduler.pending, 'callbacks left after the block was done').toBe(0);
    expect(redraws.calls, 'redraws when every slice was written in place').toBe(0);
  });

  it('moves to the next block when one is done', async () => {
    const scheduler = installIdle();
    const first = new ScriptedBlock(drawBlock(['a']), [sliceOf(0, ['A'], 1, true)]);
    const second = new ScriptedBlock(drawBlock(['b']), [sliceOf(0, ['B'], 1, true)]);
    continueHighlightsInSlices([first, second], new RedrawCounter().redraw);

    await scheduler.runIdle();
    expect([first.budgets.length, second.budgets.length], 'slices after one callback').toEqual([
      1, 0,
    ]);
    await scheduler.runIdle();

    expect([first.budgets.length, second.budgets.length], 'slices after two callbacks').toEqual([
      1, 1,
    ]);
  });

  it('cancels the pending slice, and every later one', async () => {
    const scheduler = installIdle();
    const block = new ScriptedBlock(drawBlock(['a', 'b']), [
      sliceOf(0, ['A'], 2),
      sliceOf(1, ['B'], 2, true),
    ]);
    const cancel = continueHighlightsInSlices([block], new RedrawCounter().redraw);
    await scheduler.runIdle();
    expect(scheduler.pending, 'slice waiting after the first').toBe(1);

    cancel();
    await scheduler.runIdle();

    expect(scheduler.pending, 'slices waiting after cancel').toBe(0);
    expect(block.budgets.length, 'slices run in all').toBe(1);
  });

  it('writes nothing into a block that left the page, and draws the message again at the end', async () => {
    const scheduler = installIdle();
    const pre = drawBlock(['a', 'b']);
    const block = new ScriptedBlock(pre, [sliceOf(0, ['A', 'B'], 2, true)]);
    const redraws = new RedrawCounter();
    continueHighlightsInSlices([block], redraws.redraw);

    pre.remove();
    await scheduler.runIdle();

    expect(lineTexts(pre), 'texts of the detached block').toEqual(['a', 'b']);
    expect(redraws.calls, 'redraws after an unpatched block finished').toBe(1);
  });

  it('draws the message again once, after the last block, when several could not be patched', async () => {
    const scheduler = installIdle();
    const detached = () => {
      const pre = drawBlock(['a']);
      pre.remove();
      return pre;
    };
    const blocks = [detached(), detached()].map(
      (pre) => new ScriptedBlock(pre, [sliceOf(0, ['A'], 1, true)])
    );
    const redraws = new RedrawCounter();
    continueHighlightsInSlices(blocks, redraws.redraw);

    await scheduler.runIdle();
    expect(redraws.calls, 'redraws after the first block').toBe(0);
    await scheduler.runIdle();

    expect(redraws.calls, 'redraws after the last block').toBe(1);
  });

  it('does not draw the message again after a cancel', async () => {
    const scheduler = installIdle();
    const pre = drawBlock(['a']);
    pre.remove();
    const block = new ScriptedBlock(pre, [sliceOf(0, ['A'], 1, true)]);
    const redraws = new RedrawCounter();
    const cancel = continueHighlightsInSlices([block], redraws.redraw);

    cancel();
    await scheduler.runIdle();

    expect(redraws.calls, 'redraws of a run cancelled before its first slice').toBe(0);
    expect(block.budgets, 'slices run after the cancel').toEqual([]);
  });

  it('asks again after a stop when the highlighter allows a retry, and moves on when it does not', async () => {
    const scheduler = installIdle();
    const retried = new ScriptedBlock(drawBlock(['a']), [null, sliceOf(0, ['A'], 1, true)], true);
    const refused = new ScriptedBlock(drawBlock(['b']), [null], false);
    const after = new ScriptedBlock(drawBlock(['c']), [sliceOf(0, ['C'], 1, true)]);
    continueHighlightsInSlices([retried, refused, after], new RedrawCounter().redraw);

    await scheduler.runIdle();
    expect(retried.budgets.length, 'asks of the stopped block after one callback').toBe(1);
    await scheduler.runIdle();
    expect(retried.budgets.length, 'asks of the retried block after two callbacks').toBe(2);
    await scheduler.runIdle();
    expect(refused.budgets.length, 'asks of the block that may not retry').toBe(1);
    await scheduler.runIdle();

    expect(after.budgets.length, 'asks of the block after a refused one').toBe(1);
    expect(scheduler.pending).toBe(0);
  });

  it('asks each block from the line its own page has reached, then from where its last slice ended', async () => {
    const scheduler = installIdle();
    const texts = ['a', 'b', 'c', 'd', 'e', 'f'];
    // Two lines coloured by the first draw; the slices cover lines 2-3, then 4-5.
    const block = new ScriptedBlock(drawPartlyColouredBlock(texts, 2), [
      sliceOf(2, ['C', 'D'], 6),
      sliceOf(4, ['E', 'F'], 6, true),
    ]);
    continueHighlightsInSlices([block], new RedrawCounter().redraw);

    await scheduler.runIdle();
    await scheduler.runIdle();

    expect(block.fromLines, 'lines the loop said were coloured, at each ask').toEqual([2, 4]);
    expect(lineTexts(block.pre), 'line texts after both slices').toEqual([
      'a',
      'b',
      'C',
      'D',
      'E',
      'F',
    ]);
  });

  it('draws the message again, and asks nothing, for a block another block with its text finished', async () => {
    const scheduler = installIdle();
    const finishedElsewhere = new ScriptedBlock(
      drawPartlyColouredBlock(['a', 'b'], 1),
      [sliceOf(1, ['B'], 2, true)],
      false,
      false
    );
    const after = new ScriptedBlock(drawBlock(['c']), [sliceOf(0, ['C'], 1, true)]);
    const redraws = new RedrawCounter();
    continueHighlightsInSlices([finishedElsewhere, after], redraws.redraw);

    await scheduler.runIdle();
    await scheduler.runIdle();

    expect(finishedElsewhere.budgets, 'asks of a block that is not pending').toEqual([]);
    expect(after.budgets.length, 'asks of the block after it').toBe(1);
    expect(redraws.calls, 'redraws of the message').toBe(1);
  });

  it('still takes the retry of a block that is not pending because it stopped on the time limit', async () => {
    const scheduler = installIdle();
    const stopped = new ScriptedBlock(
      drawPartlyColouredBlock(['a', 'b'], 1),
      [null, sliceOf(1, ['B'], 2, true)],
      true,
      false
    );
    const redraws = new RedrawCounter();
    continueHighlightsInSlices([stopped], redraws.redraw);

    await scheduler.runIdle();
    await scheduler.runIdle();

    expect(stopped.fromLines, 'both asks start at the stopped slice').toEqual([1, 1]);
    expect(redraws.calls, 'redraws after a retry that landed').toBe(0);
  });
});

describe('colouredLinesIn', () => {
  it('counts the lines before the first plain one', () => {
    expect(colouredLinesIn(drawPartlyColouredBlock(['a', 'b', 'c', 'd'], 2))).toBe(2);
  });

  it('is the line count when every line is coloured, and 0 when none is', () => {
    expect(colouredLinesIn(drawPartlyColouredBlock(['a', 'b', 'c'], 3)), 'all coloured').toBe(3);
    expect(colouredLinesIn(drawPartlyColouredBlock(['a', 'b', 'c'], 0)), 'none coloured').toBe(0);
  });

  it('counts through the groups of a long block', () => {
    const coloured = HIGHLIGHT_GROUP_LINES * 2 + 3;
    const lines = numberedLines(LONG_BLOCK_LINES).map((text, index) =>
      index < coloured
        ? `<span class="line"><span style="color:#fff">${text}</span></span>`
        : `<span class="line"><span>${text}</span></span>`
    );
    const pre = document.createElement('pre');
    pre.innerHTML = `<code>${groupedLinesHtml(lines)}</code>`;
    document.body.append(pre);
    mounted.push(pre);

    expect(colouredLinesIn(pre)).toBe(coloured);
  });

  it('steps over an empty line, which has no token to colour', () => {
    const pre = document.createElement('pre');
    pre.innerHTML =
      '<code><span class="line"><span style="color:#fff">a</span></span>\n<span class="line"></span>\n<span class="line"><span>c</span></span></code>';
    document.body.append(pre);
    mounted.push(pre);

    expect(colouredLinesIn(pre)).toBe(2);
  });

  it('is 0 for a block with no code element', () => {
    expect(colouredLinesIn(document.createElement('pre'))).toBe(0);
  });
});
