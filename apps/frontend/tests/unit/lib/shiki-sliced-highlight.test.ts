import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

import {
  groupedLinesHtml,
  HIGHLIGHT_CATCH_UP_LINES,
  HIGHLIGHT_GROUP_CLASS,
  HIGHLIGHT_GROUP_LINES,
  type HighlightSlice,
  isGroupedBlock,
} from '@/lib/highlight-slices';
import {
  continueHighlight,
  highlightCode,
  initHighlighter,
  isHighlightContinuationPending,
  isHighlightRetryPending,
  observeTokenizedLines,
  preloadCodeLanguages,
  releaseHighlightSessions,
  setTimeStopClock,
} from '@/lib/shiki';
import { createCheckedRenderers } from '@/lib/shiki-checked-render';

import { SteppingClock } from '../../support/mocks/fake-stepping-clock';
import {
  EveryLineStopsTokenizerClock,
  frozenTokenizerClock,
  withTokenizerClock,
} from '../../support/mocks/fake-tokenizer-clock';

const THEME = 'one-dark-pro';
const BUDGET_MS = 25;
/** Lines tokenized between two clock reads; a budgeted call is sliced in steps of this size. */
const BATCH_LINES = 16;
/** A budgeted call colours this many lines, or fewer, in one go: a short block is never sliced. */
const UNSLICED_LINES = 64;

let highlighter: Awaited<ReturnType<typeof initHighlighter>>;

beforeAll(async () => {
  await preloadCodeLanguages(['ts', 'json'], THEME);
  highlighter = await initHighlighter();
  // Warm the grammar's regexes under a frozen clock so a cold compile cannot trip the time limit.
  withTokenizerClock(frozenTokenizerClock, () => highlightCode('const warm = 1;', 'ts', THEME));
});

afterEach(() => {
  setTimeStopClock(null);
  observeTokenizedLines(null);
});

class TokenizedLineRecorder {
  readonly lines: string[] = [];
  readonly observe = (line: string): void => {
    this.lines.push(line);
  };
}

function recordTokenizedLines(): TokenizedLineRecorder {
  const recorder = new TokenizedLineRecorder();
  observeTokenizedLines(recorder.observe);
  return recorder;
}

/** Multi-line constructs, so a wrong carried state shows as wrong HTML. */
function typescriptBlock(label: string, repeats: number): string {
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

function withFrozenDateNow<T>(run: () => T): T {
  return withTokenizerClock(frozenTokenizerClock, run);
}

/** The block as one tokenizer call draws it: in groups when it is long, the shape `highlightCode` makes. */
function oneShotHtml(code: string, lang = 'typescript'): string {
  const renderers = createCheckedRenderers(highlighter);
  const options = { lang, theme: THEME };
  const tokens = renderers.codeToTokensBase(code, { ...options, tokenizeTimeLimit: 500 });
  const lines = renderers.tokenLinesToHtml(tokens, options);
  return renderers.htmlFromLines(
    isGroupedBlock(lines.length) ? [groupedLinesHtml(lines)] : lines,
    options
  );
}

/** The same block with every line flat, whatever its length. */
function flatOneShotHtml(code: string, lang = 'typescript'): string {
  const renderers = createCheckedRenderers(highlighter);
  const options = { lang, theme: THEME };
  const tokens = renderers.codeToTokensBase(code, { ...options, tokenizeTimeLimit: 500 });
  return renderers.htmlFromLines(renderers.tokenLinesToHtml(tokens, options), options);
}

/** The text a reader sees: the markup parsed by the DOM, so entities come back decoded. */
function textOfHtml(html: string | null): string {
  const holder = document.createElement('div');
  holder.innerHTML = html ?? '';
  return holder.textContent ?? '';
}

/** The markup of each `<span class="line">` in `html`, whether the block is flat or in groups. */
function lineMarkup(html: string | null): string[] {
  const holder = document.createElement('div');
  holder.innerHTML = html ?? '';
  return [...holder.querySelectorAll('.line')].map((line) => line.outerHTML);
}

/** The block's html split at its line breaks: the first element also holds the `<pre><code>` opening. */
function htmlLines(html: string | null): string[] {
  return (html ?? '').split('\n');
}

/**
 * Runs `continueHighlight` until the block is done; returns every slice it produced. The clock
 * moves `stepMs` per read: past the budget by default, so each slice is one batch.
 */
function sliceToTheEnd(
  code: string,
  lang: string,
  stepMs = BUDGET_MS + 5,
  maxSlices = 1_000
): HighlightSlice[] {
  const slices: HighlightSlice[] = [];
  const clock = new SteppingClock(stepMs);
  setTimeStopClock(clock.now);
  for (let guard = 0; guard < maxSlices; guard++) {
    const slice = withFrozenDateNow(() => continueHighlight(code, lang, THEME, BUDGET_MS));
    if (slice === null) break;
    slices.push(slice);
    if (slice.done) break;
  }
  return slices;
}

describe('highlightCode with a time budget', () => {
  it('colours whole batches until the budget has passed and draws the rest plain', () => {
    const code = typescriptBlock('budgeted', 20);
    // 10 ms per read: the deadline read, then 10, 20 (inside 25 ms) and 30 (past it) after batches 1-3.
    setTimeStopClock(new SteppingClock(10).now);

    const html = withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));

    // Three whole batches; a blank line has no token, so it is neither coloured nor plain text.
    const lines = htmlLines(html);
    const coloured = lines.map((line) => line.includes('<span style="color:'));
    const sourceLines = code.split('\n');
    const batchedLines = BATCH_LINES * 3;
    expect(
      sourceLines.slice(0, batchedLines).filter((text, line) => text !== '' && !coloured[line]),
      'non-blank lines in the first three batches that are plain'
    ).toEqual([]);
    expect(
      sourceLines
        .slice(batchedLines)
        .filter((text, line) => text !== '' && coloured[batchedLines + line]),
      'lines past the third batch that are coloured'
    ).toEqual([]);
    expect(isHighlightContinuationPending(code, 'ts', THEME), 'continuation pending').toBe(true);
  });

  it('keeps every line of the block, coloured or plain', () => {
    const code = typescriptBlock('keepsEveryLine', 20);
    setTimeStopClock(new SteppingClock(10).now);

    const html = withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));

    expect(htmlLines(html), 'html lines for a 200-line block').toHaveLength(200);
    expect(textOfHtml(html)).toContain('const keepsEveryLine = 1;');
  });

  it('does not slice a block of at most 64 lines, however slow the clock', () => {
    const code = typescriptBlock('shortBlock', 7).split('\n').slice(0, UNSLICED_LINES).join('\n');
    setTimeStopClock(new SteppingClock(1_000).now);

    const html = withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));

    expect(html, 'html of a 64-line block under a spent budget').toBe(oneShotHtml(code));
    expect(isHighlightContinuationPending(code, 'ts', THEME), 'continuation pending').toBe(false);
  });

  it('draws a block over 64 lines in groups with the text of the flat block, and a short one flat', () => {
    const longCode = typescriptBlock('groupedLong', 20);
    const shortCode = typescriptBlock('groupedShort', 6)
      .split('\n')
      .slice(0, UNSLICED_LINES)
      .join('\n');

    const longHtml = withFrozenDateNow(() => highlightCode(longCode, 'ts', THEME));
    const shortHtml = withFrozenDateNow(() => highlightCode(shortCode, 'ts', THEME));

    expect(longHtml, 'long block carries groups').toContain(`class="${HIGHLIGHT_GROUP_CLASS}"`);
    expect(textOfHtml(longHtml), 'text of the long block').toBe(
      textOfHtml(flatOneShotHtml(longCode))
    );
    expect(shortHtml, 'short block has no groups').not.toContain(HIGHLIGHT_GROUP_CLASS);
    expect(shortHtml, 'short block markup').toBe(flatOneShotHtml(shortCode));
  });

  it('draws the lines of a first draw that is partly coloured in the same groups', () => {
    const code = typescriptBlock('groupedPartial', 20);
    setTimeStopClock(new SteppingClock(10).now);

    const html = withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));

    const groupCount = (html ?? '').split(`class="${HIGHLIGHT_GROUP_CLASS}"`).length - 1;
    expect(groupCount, 'groups of a 200-line block').toBe(Math.ceil(200 / HIGHLIGHT_GROUP_LINES));
    expect(textOfHtml(html), 'text of the partly coloured block').toBe(
      textOfHtml(flatOneShotHtml(code))
    );
  });

  it('colours the whole block in one call when there is no budget', () => {
    const code = typescriptBlock('noBudget', 20);

    const html = withFrozenDateNow(() => highlightCode(code, 'ts', THEME));

    expect(html).toBe(oneShotHtml(code));
    expect(isHighlightContinuationPending(code, 'ts', THEME), 'continuation pending').toBe(false);
  });

  it('does not cache a partly coloured block as the answer for its source', () => {
    const code = typescriptBlock('notCachedPartial', 20);
    setTimeStopClock(new SteppingClock(10).now);
    const first = withFrozenDateNow(() =>
      highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS })
    );
    const recorder = recordTokenizedLines();

    const second = withFrozenDateNow(() => highlightCode(code, 'ts', THEME));

    expect(second, 'html after a call with no budget').toBe(oneShotHtml(code));
    expect(second).not.toBe(first);
    // Only the lines the first call left: its 48 are in the session and not tokenized again.
    expect(recorder.lines.length, 'lines tokenized by the finishing call').toBeLessThan(160);
  });
});

describe('continueHighlight', () => {
  it('finishes a block in contiguous slices that each stay near the budget', () => {
    const code = typescriptBlock('contiguous', 40);
    setTimeStopClock(new SteppingClock(10).now);
    withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));
    const coloredByFirstDraw = BATCH_LINES * 3;

    const slices = sliceToTheEnd(code, 'ts');

    expect(slices.length, 'slices for a 400-line block').toBeGreaterThan(2);
    expect(slices[0]?.fromLine, 'first slice starts after the first draw').toBe(coloredByFirstDraw);
    for (const [index, slice] of slices.entries()) {
      const previous = slices[index - 1];
      if (previous) {
        expect(slice.fromLine, `slice ${index} start`).toBe(
          previous.fromLine + previous.lineHtml.length
        );
      }
      // Each slice stops at the first batch boundary past the budget (one clock read is 30 ms
      // here), except the last stretch: 64 lines or fewer land together, plus the open line.
      expect(slice.lineHtml.length, `lines in slice ${index}`).toBeLessThanOrEqual(
        UNSLICED_LINES + 1
      );
      if (index < slices.length - 1) {
        expect(slice.lineHtml.length, `lines in slice ${index}`).toBe(BATCH_LINES);
      }
      expect(slice.lineCount, `line count of slice ${index}`).toBe(400);
      expect(slice.done, `slice ${index} done`).toBe(index === slices.length - 1);
    }
    const last = slices.at(-1);
    expect((last?.fromLine ?? 0) + (last?.lineHtml.length ?? 0), 'lines covered').toBe(400);
  });

  it('leaves the finished block in the result cache, equal to tokenizing it in one go', () => {
    const code = typescriptBlock('cachesWhenDone', 20);
    setTimeStopClock(new SteppingClock(10).now);
    withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));
    sliceToTheEnd(code, 'ts');
    const recorder = recordTokenizedLines();

    const html = withFrozenDateNow(() => highlightCode(code, 'ts', THEME));

    expect(html).toBe(oneShotHtml(code));
    expect(recorder.lines, 'lines tokenized by a draw of the finished block').toEqual([]);
    expect(isHighlightContinuationPending(code, 'ts', THEME), 'continuation pending').toBe(false);
  });

  it('carries the grammar state across slices, so the lines match tokenizing in one go', () => {
    const code = typescriptBlock('carriesState', 20);
    setTimeStopClock(new SteppingClock(10).now);
    const firstDraw = withFrozenDateNow(() =>
      highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS })
    );
    const slices = sliceToTheEnd(code, 'ts');

    // The first draw's lines, with each slice laid over them where it lands.
    const lines = lineMarkup(firstDraw);
    for (const slice of slices) {
      for (const [offset, html] of slice.lineHtml.entries()) {
        lines[slice.fromLine + offset] = lineMarkup(html)[0] ?? '';
      }
    }

    expect(lines, 'lines after slicing').toEqual(lineMarkup(oneShotHtml(code)));
  });

  it('tokenizes no more than one budget of lines in a call, however long the block is', () => {
    const code = typescriptBlock('oneBudgetPerCall', 200);
    // 10 ms per clock read, 25 ms budget: the read after the third batch passes it.
    const readMs = 10;
    setTimeStopClock(new SteppingClock(readMs).now);
    withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));
    const recorder = recordTokenizedLines();
    const budgetLines = BATCH_LINES * Math.ceil(BUDGET_MS / readMs);

    const perCall: number[] = [];
    let slice: HighlightSlice | null = null;
    for (let call = 0; call < 20; call++) {
      const before = recorder.lines.length;
      slice = withFrozenDateNow(() => continueHighlight(code, 'ts', THEME, BUDGET_MS));
      perCall.push(recorder.lines.length - before);
      if (slice === null || slice.done) break;
    }

    expect(Math.max(...perCall), 'most lines tokenized by one call').toBeLessThanOrEqual(
      budgetLines
    );
    expect(Math.min(...perCall), 'fewest lines tokenized by one call').toBeGreaterThan(0);
    expect(slice?.done, 'a 2,000-line block finished within 20 calls').toBe(false);
  });

  it('starts at the line the caller has coloured, and hands a caller behind the session its lines without tokenizing', () => {
    const code = typescriptBlock('callerBehind', 20);
    setTimeStopClock(new SteppingClock(10).now);
    // Two draws of the same text (the same fence twice): the second moves the session on.
    withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));
    withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));
    const coloured = BATCH_LINES * 3;
    const recorder = recordTokenizedLines();

    const slice = withFrozenDateNow(() =>
      continueHighlight(code, 'ts', THEME, BUDGET_MS, coloured)
    );

    expect(recorder.lines, 'lines tokenized for a caller that is behind').toEqual([]);
    expect(slice?.fromLine, 'slice starts at the caller line').toBe(coloured);
    expect(slice?.lineHtml.length, 'lines the session had ahead of the caller').toBe(coloured);
    expect(slice?.done, 'slice done').toBe(false);
    expect(lineMarkup(`<code>${(slice?.lineHtml ?? []).join('\n')}</code>`)).toEqual(
      lineMarkup(oneShotHtml(code)).slice(coloured, coloured * 2)
    );
  });

  it('brings a caller far behind the session its lines in slices of at most the catch-up size', () => {
    const code = typescriptBlock('farBehind', 200);
    setTimeStopClock(new SteppingClock(10).now);
    withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));
    // Another block with this text takes the session to about 1,000 lines.
    const sessionLines = sliceToTheEnd(code, 'ts', 10, 20).length;
    const recorder = recordTokenizedLines();

    const slice = withFrozenDateNow(() => continueHighlight(code, 'ts', THEME, BUDGET_MS, 0));

    expect(sessionLines, 'slices that moved the session').toBe(20);
    expect(recorder.lines, 'lines tokenized for a caller that is behind').toEqual([]);
    expect(slice?.fromLine, 'slice starts at the caller line').toBe(0);
    expect(slice?.lineHtml.length, 'lines in a catch-up slice').toBe(HIGHLIGHT_CATCH_UP_LINES);
  });

  it('keeps callers with their own progress on one session without a gap or a repeat of tokenizing', () => {
    const code = typescriptBlock('twoCallers', 40);
    setTimeStopClock(new SteppingClock(10).now);
    withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));
    withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));
    const recorder = recordTokenizedLines();
    // The first caller shows the first draw's 48 lines; the second shows the second draw's 96.
    const callers = [
      { name: 'first', next: BATCH_LINES * 3, lines: [] as string[], done: false },
      { name: 'second', next: BATCH_LINES * 6, lines: [] as string[], done: false },
    ];

    for (let round = 0; round < 200 && callers.some((caller) => !caller.done); round++) {
      for (const caller of callers) {
        if (caller.done) continue;
        const slice = withFrozenDateNow(() =>
          continueHighlight(code, 'ts', THEME, BUDGET_MS, caller.next)
        );
        // Null: the other caller finished the block. That caller is drawn from the cache.
        if (slice === null) {
          caller.done = true;
          continue;
        }
        expect(slice.fromLine, `${caller.name} slice start`).toBe(caller.next);
        caller.next = slice.fromLine + slice.lineHtml.length;
        caller.done = slice.done;
      }
    }

    expect(
      callers.every((caller) => caller.done),
      'callers finished'
    ).toBe(true);
    // Every line once, plus the open last line once more when the block ends.
    expect(recorder.lines.length, 'lines tokenized for both callers').toBeLessThanOrEqual(
      code.split('\n').length - BATCH_LINES * 6 + 1
    );
  });

  it('does nothing for a block that is not partly drawn', () => {
    const code = typescriptBlock('neverDrawn', 3);

    expect(continueHighlight(code, 'ts', THEME, BUDGET_MS)).toBeNull();
    expect(isHighlightContinuationPending(code, 'ts', THEME)).toBe(false);
  });

  it('carries on from where it was after the sessions are released', () => {
    const code = typescriptBlock('releasedMidWay', 20);
    setTimeStopClock(new SteppingClock(10).now);
    withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));

    // A stream ending releases the sessions of finished blocks; this one still has lines to do.
    releaseHighlightSessions();
    const slices = sliceToTheEnd(code, 'ts');

    expect(slices[0]?.fromLine, 'first slice after the release').toBe(BATCH_LINES * 3);
  });

  it('keeps the session of an unfinished block above the per-entry size bound', () => {
    // About 55 characters of source and 700 of html per line: past 500,000 html characters
    // before the 12,000 lines end, with the block still unfinished.
    const code = Array.from(
      { length: 12_000 },
      (_, line) => `{"seed": 7, "line": ${line}, "a": [1, 2, 3]}`
    ).join('\n');
    setTimeStopClock(new SteppingClock(10).now);
    withFrozenDateNow(() => highlightCode(code, 'json', THEME, { budgetMs: BUDGET_MS }));

    // One millisecond a read: about 25 batches (400 lines) a slice, so the 12,000 lines take 30.
    const slices = sliceToTheEnd(code, 'json', 1);

    const restarts = slices.filter(
      (slice, index) => index > 0 && slice.fromLine < (slices[index - 1]?.fromLine ?? 0)
    );
    expect(restarts, 'slices that went back to an earlier line').toEqual([]);
    expect(slices.at(-1)?.done, 'last slice done').toBe(true);
    expect(slices.at(-1)?.fromLine, 'last slice start').toBeGreaterThan(11_000);
  });
});

describe('continueHighlight and the tokenizer time limit', () => {
  it('keeps the lines it coloured when a later slice stops, and retries once', () => {
    const code = typescriptBlock('stopsOnce', 20);
    setTimeStopClock(new SteppingClock(10).now);
    withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));

    const stopped = withTokenizerClock(new EveryLineStopsTokenizerClock().now, () =>
      continueHighlight(code, 'ts', THEME, BUDGET_MS)
    );

    expect(stopped, 'slice that hit the time limit').toBeNull();
    expect(isHighlightRetryPending(code, 'ts', THEME), 'retry pending after a stop').toBe(true);
    // The retry has its own owner: a slice loop asks `isHighlightRetryPending`, not this.
    expect(isHighlightContinuationPending(code, 'ts', THEME), 'continuation pending').toBe(false);

    const slices = sliceToTheEnd(code, 'ts');
    expect(slices[0]?.fromLine, 'retry starts where the stopped slice began').toBe(BATCH_LINES * 3);
    expect(slices.at(-1)?.done, 'retry finishes the block').toBe(true);
  });

  it('gives up after a second stop and does not tokenize again', () => {
    const code = typescriptBlock('stopsTwice', 20);
    setTimeStopClock(new SteppingClock(10).now);
    withFrozenDateNow(() => highlightCode(code, 'ts', THEME, { budgetMs: BUDGET_MS }));
    for (let stop = 0; stop < 2; stop++) {
      withTokenizerClock(new EveryLineStopsTokenizerClock().now, () =>
        continueHighlight(code, 'ts', THEME, BUDGET_MS)
      );
    }
    const recorder = recordTokenizedLines();

    const third = withFrozenDateNow(() => continueHighlight(code, 'ts', THEME, BUDGET_MS));

    expect(third, 'slice after two stops').toBeNull();
    expect(isHighlightRetryPending(code, 'ts', THEME), 'retry pending after two stops').toBe(false);
    // A given-up block is refused, so no caller should schedule a slice for it.
    expect(isHighlightContinuationPending(code, 'ts', THEME), 'continuation pending').toBe(false);
    expect(recorder.lines, 'lines tokenized after the block gave up').toEqual([]);
  });
});
