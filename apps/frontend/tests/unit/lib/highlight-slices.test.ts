import { afterEach, describe, expect, it } from 'bun:test';

import {
  continueHighlightsInSlices,
  HIGHLIGHT_SLICE_IDLE_TIMEOUT_MS,
  HIGHLIGHT_SLICE_MS,
  type HighlightSlice,
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
  private next = 0;

  constructor(
    readonly pre: Element,
    private readonly answers: readonly (HighlightSlice | null)[],
    private readonly retriesAfterStop = false
  ) {}

  advance = (budgetMs: number): HighlightSlice | null => {
    this.budgets.push(budgetMs);
    return this.answers[this.next++] ?? null;
  };

  canRetryAfterStop = (): boolean => this.retriesAfterStop;
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
});
