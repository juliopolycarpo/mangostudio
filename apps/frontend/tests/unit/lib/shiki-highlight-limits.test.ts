import { afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';

import {
  highlightCode,
  highlightLineTokens,
  initHighlighter,
  preloadCodeLanguages,
} from '@/lib/shiki';
import { createCheckedRenderers } from '@/lib/shiki-checked-render';

/**
 * A source over the budget must never reach the grammar: the tokenizer is quadratic in one
 * unbroken word and cannot be interrupted, so what matters is that it is not called.
 */
const SCALING_INPUT_LENGTH = 16_384;
const SCALING_BOUND_MS = 250;
/** The largest word that fits a quadratic grammar's budget; see `code-highlight-limits`. */
const LARGEST_FITTING_WORD = 547;
const THEME = 'one-dark-pro';

let highlighter: Awaited<ReturnType<typeof initHighlighter>>;
let restore: (() => void) | undefined;

beforeAll(async () => {
  await preloadCodeLanguages(['ts'], THEME);
  highlighter = await initHighlighter();
  const realNow = Date.now;
  try {
    // Warm the grammar's regexes with a frozen clock so a cold first call cannot hit the deadline.
    Date.now = frozenClock;
    highlightCode('const warm = 1;', 'ts', THEME);
  } finally {
    Date.now = realNow;
  }
});

afterEach(() => {
  restore?.();
  restore = undefined;
});

function frozenClock(): number {
  return 0;
}

/** Spies on `tokenizeLine2` of the real TypeScript grammar and lets the calls run. */
function spyOnTokenizer() {
  const grammar = highlighter.getLanguage('typescript');
  const spy = spyOn(grammar, 'tokenizeLine2');
  restore = () => spy.mockRestore();
  return spy;
}

/** Every line text the tokenizer was asked to tokenize. */
function tokenizedLines(spy: ReturnType<typeof spyOnTokenizer>): string[] {
  return spy.mock.calls.map(([line]) => line);
}

function highlightWithFrozenClock(code: string): string | null {
  const realNow = Date.now;
  try {
    Date.now = frozenClock;
    return highlightCode(code, 'ts', THEME);
  } finally {
    Date.now = realNow;
  }
}

/** The inline colours in `html`, one per coloured span, in order. */
function colouredSpans(html: string): number {
  return html.match(/<span style="color:/g)?.length ?? 0;
}

/** Highlights `prefix` from scratch with the same renderers, as the reference for a streamed prefix. */
function oneShotHtml(prefix: string): string {
  const renderers = createCheckedRenderers(highlighter);
  const options = { lang: 'typescript', theme: THEME };
  const tokens = renderers.codeToTokensBase(prefix, { ...options, tokenizeTimeLimit: 500 });
  return renderers.htmlFromLines(renderers.tokenLinesToHtml(tokens, options), options);
}

describe('highlightCode budget', () => {
  it('highlights a word at the limit', () => {
    const tokenizer = spyOnTokenizer();
    const html = highlightWithFrozenClock('x'.repeat(LARGEST_FITTING_WORD));

    expect(html).toContain('shiki');
    expect(tokenizer).toHaveBeenCalled();
  });

  it('refuses a word one character over the limit without calling the tokenizer', () => {
    const tokenizer = spyOnTokenizer();
    const html = highlightWithFrozenClock('x'.repeat(LARGEST_FITTING_WORD + 1));

    expect(html, 'expected null for a word over the limit').toBeNull();
    expect(tokenizer.mock.calls.length, 'tokenizer calls for a word over the limit').toBe(0);
  });

  it('highlights the lines before an over-limit line and draws the rest plain', () => {
    const tokenizer = spyOnTokenizer();
    const overLimit = `const big = "${'q'.repeat(2000)}";`;
    const html = highlightWithFrozenClock(`const first = 1;\n${overLimit}\nconst after = 2;`);

    expect(html).toContain('shiki');
    expect(html).toContain('first');
    expect(html).toContain(overLimit);
    expect(html).toContain('const after = 2;');
    // Only the first line is coloured: it has more than one coloured span, the others none.
    const [coloured, ...plain] = (html ?? '').split('<span class="line">').slice(1);
    expect(
      colouredSpans(coloured ?? ''),
      'coloured spans on the line before the limit'
    ).toBeGreaterThan(0);
    expect(
      plain.map(colouredSpans),
      'coloured spans on the lines from the over-limit line on'
    ).toEqual([0, 0]);
    expect(tokenizedLines(tokenizer), 'lines the tokenizer was given').toEqual([
      'const first = 1;',
    ]);
  });

  it('keeps every line after an over-limit line plain, because the state after it is unknown', () => {
    // The long line opens a template literal. Colouring the next line as code would look right
    // and be wrong, so nothing after the long line is coloured, even though that line is cheap.
    const opener = `const text = \`${'w'.repeat(2000)}`;
    const tokenizer = spyOnTokenizer();
    const html = highlightWithFrozenClock(
      `const before = 0;\n${opener}\nconst inside = 1;\n\`;\nconst outside = 2;`
    );

    expect(html).toContain('const inside = 1;');
    expect(
      tokenizedLines(tokenizer).filter(
        (line) => line.includes('inside') || line.includes('outside')
      ),
      'lines after the over-limit line given to the tokenizer'
    ).toEqual([]);
  });

  it(`refuses ${SCALING_INPUT_LENGTH} characters of one identifier in under ${SCALING_BOUND_MS} ms`, () => {
    const tokenizer = spyOnTokenizer();
    const start = performance.now();
    const html = highlightCode('x'.repeat(SCALING_INPUT_LENGTH), 'ts', THEME);
    const elapsed = performance.now() - start;

    expect(html).toBeNull();
    expect(tokenizer.mock.calls.length).toBe(0);
    expect(elapsed, `${SCALING_INPUT_LENGTH} characters took ${elapsed}ms`).toBeLessThan(
      SCALING_BOUND_MS
    );
  });

  it('still highlights a long URL, a path and a regex that are not word runs', () => {
    const url = `const u = "https://example.com/${'a/b.c-d_e?f=g&h=1/'.repeat(100)}";`;
    const html = highlightWithFrozenClock(url);

    expect(html, 'expected a long URL in a string to be highlighted').toContain('shiki');
    expect(colouredSpans(html ?? '')).toBeGreaterThan(0);
  });
});

describe('highlightLineTokens limits', () => {
  it('colours a normal line and refuses an over-limit one without calling the tokenizer', () => {
    const tokenizer = spyOnTokenizer();
    const realNow = Date.now;
    try {
      Date.now = frozenClock;
      expect(highlightLineTokens('const value = 1;', 'ts', THEME)).not.toBeNull();
      const callsBefore = tokenizer.mock.calls.length;
      expect(highlightLineTokens('x'.repeat(LARGEST_FITTING_WORD + 1), 'ts', THEME)).toBeNull();
      expect(tokenizer.mock.calls.length).toBe(callsBefore);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('highlightCode cache', () => {
  it('tokenizes an unchanged block once and returns the same html', () => {
    const tokenizer = spyOnTokenizer();
    const code = 'const cachedBlock = 1;\nconst second = 2;';

    const first = highlightWithFrozenClock(code);
    const callsAfterFirst = tokenizer.mock.calls.length;
    const second = highlightWithFrozenClock(code);

    expect(first).toContain('shiki');
    expect(second).toBe(first);
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(tokenizer.mock.calls.length, 'tokenizer calls for an unchanged block').toBe(
      callsAfterFirst
    );
  });

  it('keeps a different theme apart from the same code', async () => {
    await preloadCodeLanguages(['ts'], 'github-light');
    const dark = highlightWithFrozenClock('const themed = 1;');
    const realNow = Date.now;
    let light: string | null;
    try {
      Date.now = frozenClock;
      light = highlightCode('const themed = 1;', 'ts', 'github-light');
    } finally {
      Date.now = realNow;
    }

    expect(light).not.toBe(dark);
  });

  it('evicts the least recently used block past its capacity', () => {
    const tokenizer = spyOnTokenizer();
    const blocks = Array.from({ length: 17 }, (_, index) => `const block${index} = ${index};`);
    for (const block of blocks) highlightWithFrozenClock(block);
    const before = tokenizer.mock.calls.length;

    highlightWithFrozenClock(blocks[16] ?? '');
    expect(tokenizer.mock.calls.length, 'the newest block is still cached').toBe(before);

    highlightWithFrozenClock(blocks[0] ?? '');
    expect(tokenizer.mock.calls.length, 'the oldest block was evicted').toBeGreaterThan(before);
  });
});

describe('highlightCode on a block that grows', () => {
  // A template literal and a block comment span lines, so a wrong carried state shows as wrong HTML.
  const STREAMED_SOURCE = [
    'const a = 1;',
    'const text = `first',
    `second \${a + 1}`,
    'third`;',
    '/* a comment',
    '   over lines */',
    'function f(x: number): string {',
    `  return \`\${x}\`;`,
    '}',
    '',
  ]
    .join('\n')
    .repeat(6);

  it('renders each streamed prefix exactly as tokenizing that prefix from scratch', () => {
    // Prefixes end mid-line and on line breaks; each is new, so the cache cannot answer.
    for (let end = 1; end <= STREAMED_SOURCE.length; end += 7) {
      const prefix = STREAMED_SOURCE.slice(0, end);
      const streamed = highlightWithFrozenClock(prefix);
      expect(streamed, `prefix of ${end} characters`).toBe(oneShotHtml(prefix));
    }
  });

  it('colours the block while it is still growing', () => {
    highlightWithFrozenClock('const early = 1;\nfunction partial(');
    const html = highlightWithFrozenClock('const early = 1;\nfunction partial(a: number');

    expect(colouredSpans(html ?? ''), 'coloured spans in an unfinished block').toBeGreaterThan(5);
  });

  it('tokenizes each line about once over a 300-line stream in 30 chunks', () => {
    const lines = Array.from({ length: 300 }, (_, index) => `const streamed${index} = ${index};`);
    const tokenizer = spyOnTokenizer();
    for (let chunk = 1; chunk <= 30; chunk++) {
      highlightWithFrozenClock(lines.slice(0, chunk * 10).join('\n'));
    }

    // Quadratic tokenizing would be 30 chunks x up to 300 lines, about 4,650 calls.
    expect(
      tokenizer.mock.calls.length,
      'tokenizer calls for 300 lines streamed in 30 chunks (expected about 300 + 30)'
    ).toBeLessThan(400);
  });

  it('does not let one block seed another that only shares its first lines', () => {
    const shared = 'const shared = 1;\n';
    highlightWithFrozenClock(`${shared}const left = \`open\nstill open\n`);
    const right = `${shared}const right = 2;\nconst next = 3;\n`;

    expect(highlightWithFrozenClock(right)).toBe(oneShotHtml(right));
  });

  it('keeps the colours of earlier lines while a later line grows past the budget', () => {
    const head = 'const kept = 1;\n';
    const before = highlightWithFrozenClock(`${head}const grows = "abc`);
    const after = highlightWithFrozenClock(`${head}const grows = "${'q'.repeat(2000)}`);

    expect(before).toContain('shiki');
    expect(after).toContain('kept');
    expect(after).toContain('q'.repeat(2000));
    const keptLine = (html: string | null) => (html ?? '').split('<span class="line">')[1];
    expect(keptLine(after)).toBe(keptLine(before));
  });
});
