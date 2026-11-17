import { describe, expect, it } from 'bun:test';

import { countHighlightableLines } from '@/lib/code-highlight-limits';

/** 547² = 299,209 fits the 300,000 budget of a quadratic grammar; 548² = 300,304 does not. */
const LARGEST_FITTING_WORD = 547;

function words(length: number): string {
  return 'x'.repeat(length);
}

describe('countHighlightableLines', () => {
  it('accepts ordinary code, an empty source and blank lines', () => {
    const source = 'const value = compute(a, b);\n\n  return value;\n';
    expect(countHighlightableLines(source, 'typescript')).toBe(4);
    expect(countHighlightableLines('', 'typescript')).toBe(1);
  });

  it('never spends budget on ordinary code, however many lines', () => {
    const source =
      'export const someReasonablyNamedConstant = computeTheValue(argumentOne);\n'.repeat(10_000);
    expect(countHighlightableLines(source, 'typescript')).toBe(10_001);
  });

  it('accepts a word at the budget and refuses one character more', () => {
    expect(countHighlightableLines(words(LARGEST_FITTING_WORD), 'typescript')).toBe(1);
    expect(
      countHighlightableLines(words(LARGEST_FITTING_WORD + 1), 'typescript'),
      `a ${LARGEST_FITTING_WORD + 1}-character word on a quadratic grammar`
    ).toBe(0);
  });

  it('adds the cost of words across lines instead of judging each alone', () => {
    // Each 190-character word costs 36,100 of the 300,000 budget, so eight lines fit.
    const source = `${words(190)}\n`.repeat(20);
    expect(countHighlightableLines(source, 'typescript')).toBe(8);
  });

  it('stops at the first line that would exceed the budget, not at the cheapest after it', () => {
    const source = `const a = 1;\n${words(5000)}\nconst b = 2;\n`;
    expect(countHighlightableLines(source, 'typescript')).toBe(1);
  });

  it('counts a dotted chain, an optional chain and a run of blanks like a word', () => {
    expect(countHighlightableLines('a.'.repeat(LARGEST_FITTING_WORD), 'typescript')).toBe(0);
    expect(countHighlightableLines('a?.'.repeat(LARGEST_FITTING_WORD), 'typescript')).toBe(0);
    // A blank run costs half as much: 774² / 2 = 299,538 fits, 775² / 2 = 300,312 does not.
    expect(countHighlightableLines(`a${' '.repeat(774)}b`, 'typescript')).toBe(1);
    expect(countHighlightableLines(`a${' '.repeat(775)}b`, 'typescript')).toBe(0);
    expect(countHighlightableLines(`a${'\t'.repeat(775)}b`, 'typescript')).toBe(0);
  });

  it('gives C++ a smaller budget, because it is about twice as slow per square character', () => {
    // 412² = 169,744 fits the 170,000 budget, 413² = 170,569 does not.
    expect(countHighlightableLines(words(412), 'cpp')).toBe(1);
    expect(countHighlightableLines(words(413), 'cpp')).toBe(0);
  });

  it('lets a word-run of the same size through on grammars that are not quadratic in it', () => {
    expect(countHighlightableLines(words(LARGEST_FITTING_WORD + 1), 'python')).toBe(1);
    expect(countHighlightableLines(words(1549), 'python')).toBe(1);
    expect(countHighlightableLines(words(1550), 'python')).toBe(0);
  });

  it('counts a Unicode letter as part of a word, as the grammars do', () => {
    expect(
      countHighlightableLines(`// ${'漢'.repeat(LARGEST_FITTING_WORD + 1)}`, 'typescript')
    ).toBe(0);
  });

  it('is not tripped by long lines whose words are short: URLs, paths, minified code', () => {
    const url = `const u = "https://example.com/${'a/b.c-d_e?f=g&h=1/'.repeat(300)}";`;
    const minified = 'a.b(c,d);e.f()'.repeat(500);
    expect(countHighlightableLines(url, 'typescript')).toBe(1);
    expect(countHighlightableLines(minified, 'typescript')).toBe(1);
  });

  it('charges a long line on YAML and Java, where the line itself is quadratic', () => {
    // 1,000 characters cost 1,000² / 16 = 62,500 units, so four lines fit in 300,000.
    const line = 'a b '.repeat(250);
    expect(countHighlightableLines(`${line}\n`.repeat(6), 'yaml')).toBe(4);
    expect(countHighlightableLines(`${line}\n`.repeat(6), 'java')).toBe(4);
    expect(countHighlightableLines(`${line}\n`.repeat(6), 'python')).toBe(7);
  });

  it('splits lines on \\n, \\r\\n and \\r, as Shiki does', () => {
    expect(countHighlightableLines('a\r\nb\rc\nd', 'typescript')).toBe(4);
  });

  it('refuses a 1 MB source in well under a second, stopping at the first offending line', () => {
    const source = `${words(LARGEST_FITTING_WORD + 1)}${'\n'.repeat(1_000_000)}`;
    const start = performance.now();
    expect(countHighlightableLines(source, 'typescript')).toBe(0);
    expect(performance.now() - start).toBeLessThan(250);
  });
});
