import { describe, expect, it } from 'bun:test';

import { splitLines } from '@shikijs/core';

import { countHighlightableLines, EMBEDDED_LANGUAGES } from '@/lib/code-highlight-limits';
import { SHIKI_LANGUAGE_IDS, type ShikiLanguageId } from '@/lib/code-languages';

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

  it('colours ordinary code up to the character cap and no further', () => {
    // 72 characters and a line break: 80,000 / 73 leaves 1,095 lines inside the TypeScript cap.
    const source =
      'export const someReasonablyNamedConstant = computeTheValue(argumentOne);\n'.repeat(10_000);
    expect(countHighlightableLines(source, 'typescript')).toBe(1095);
    expect(countHighlightableLines(source.slice(0, 80_000), 'typescript')).toBeGreaterThan(1000);
  });

  it('stops 5,000 lines of five 47-character words long before the end', () => {
    // 1.2 MB in 5,000 lines took 10.6 s in TypeScript before the cap.
    const line = Array.from({ length: 5 }, () => words(47)).join(' ');
    const lines = countHighlightableLines(`${line}\n`.repeat(5000), 'typescript');
    expect(lines, 'lines coloured out of 5,000').toBeLessThan(250);
  });

  it('stops 5,000 lines of 253 characters on YAML long before the end', () => {
    // 3.7 s before the cap.
    const lines = countHighlightableLines(`${'k: v '.repeat(50)}\n`.repeat(5000), 'yaml');
    expect(lines, 'lines coloured out of 5,000').toBeLessThan(500);
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

  it('splits lines on \\n and \\r\\n only, as Shiki does', () => {
    expect(countHighlightableLines('a\r\nb\rc\nd', 'typescript')).toBe(3);
  });

  it('counts lines exactly as Shiki splitLines does, over every separator', () => {
    const separators = ['\n', '\r\n', '\r', '\u2028', '\u2029', '\f', '\v', '\n\r', '\r\r\n'];
    for (const first of separators) {
      for (const second of separators) {
        const source = `a${first}b${second}c${first}${second}d`;
        expect(
          countHighlightableLines(source, 'typescript'),
          `lines in ${JSON.stringify(source)}`
        ).toBe(splitLines(source).length);
      }
    }
  });

  it('does not end a line at a lone carriage return before an over-limit word', () => {
    const source = `a\r${words(LARGEST_FITTING_WORD + 1)}`;
    expect(
      countHighlightableLines(source, 'typescript'),
      `lines in ${JSON.stringify(source.slice(0, 12))}...`
    ).toBe(0);
  });

  it('refuses a 1 MB source in well under a second, stopping at the first offending line', () => {
    const source = `${words(LARGEST_FITTING_WORD + 1)}${'\n'.repeat(1_000_000)}`;
    const start = performance.now();
    expect(countHighlightableLines(source, 'typescript')).toBe(0);
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe('embedded grammars', () => {
  const WORD = words(1540);

  it('limits php and ruby by the strictest grammar they embed throughout', () => {
    // 1,540² is far under the default budget and far over the script one.
    expect(countHighlightableLines(WORD, 'python')).toBe(1);
    expect(countHighlightableLines(WORD, 'php'), 'word in php (embeds javascript)').toBe(0);
    expect(countHighlightableLines(WORD, 'ruby'), 'word in ruby (embeds cpp)').toBe(0);
  });

  it('limits a word in a markdown fence or an html script by that fence language', () => {
    const fenced = (lang: string) => `# Title\n\n\`\`\`${lang}\nconst a = 1;\n${WORD}\n\`\`\`\n`;
    expect(countHighlightableLines(fenced('ts'), 'markdown'), 'word in a ts fence').toBe(4);
    expect(countHighlightableLines(fenced('python'), 'markdown'), 'word in a python fence').toBe(7);
    expect(countHighlightableLines(fenced('unknown'), 'markdown'), 'unknown fence').toBe(7);
    const script = `<p>hi</p>\n<script>\nlet a = 1;\n${WORD}\n</script>\n`;
    expect(countHighlightableLines(script, 'html'), 'word in a script element').toBe(3);
    expect(countHighlightableLines(script.replace(/script/g, 'style'), 'html')).toBe(6);
  });

  it('colours a 600-line markdown document without fences in full', () => {
    const document =
      `## Notes\n\n| a${' '.repeat(60)}| b |\n- item with \`code\` and a [link](https://example.com)\n`.repeat(
        150
      );
    expect(document.split('\n').length).toBe(601);
    expect(countHighlightableLines(document, 'markdown')).toBe(601);
  });

  it('stops a markdown document inside a large cpp fence where the cpp cap says', () => {
    const cpp = 'std::vector<int> values = compute(items, count);\n';
    const document = `# T\n\n\`\`\`cpp\n${cpp.repeat(2000)}\`\`\`\n`;
    // 32,000 characters at 49 a line: 3 lines before the fence body, then 652 of the body.
    const lines = countHighlightableLines(document, 'markdown');
    expect(lines, 'lines coloured out of 2,004').toBeGreaterThan(600);
    expect(lines).toBeLessThan(700);
    // The same body in a ts fence has a 2.5x larger cap.
    const ts = `# T\n\n\`\`\`ts\n${'const a = compute(items, count);\n'.repeat(4000)}\`\`\`\n`;
    expect(countHighlightableLines(ts, 'markdown')).toBeGreaterThan(2300);
  });

  it('returns to the markdown rate once a fence closes', () => {
    // 300 cpp lines use 46% of the cpp cap, and 1,500 prose lines 33% of the markdown cap; had the
    // fence stayed open the prose would be charged at the cpp rate and pass the cap.
    const cpp = 'std::vector<int> values = compute(items, count);\n'.repeat(300);
    const prose = 'plain prose line here\n'.repeat(1500);
    for (const [open, close] of [
      ['```cpp', '```'],
      ['~~~cpp', '~~~'],
      ['```cpp', '````'],
    ] as const) {
      const document = `${open}\n${cpp}${close}\n${prose}`;
      expect(
        countHighlightableLines(document, 'markdown'),
        `fence ${open} closed by ${close}`
      ).toBe(document.split('\n').length);
    }
    const unclosed = `\`\`\`cpp\n${cpp}\`\`\`js\n${prose}`;
    expect(
      countHighlightableLines(unclosed, 'markdown'),
      'a fence line with an info string does not close'
    ).toBeLessThan(unclosed.split('\n').length);
  });

  it('charges lines on a grammar that embeds a line-cost one', () => {
    const line = 'a b '.repeat(250);
    expect(countHighlightableLines(`${line}\n`.repeat(6), 'xml'), 'xml embeds java').toBe(4);
  });

  for (const language of ['vue', 'svelte'] as const) {
    it(`caps a ${language} block at the script grammar's character limit, not the default one`, () => {
      // 90,000 characters in short lines: inside the default cap (100,000), past the script cap (80,000).
      const source = 'const a = 1;\n'.repeat(7_000);
      const lines = source.split('\n').length;

      expect(
        countHighlightableLines(source, language),
        `${language} highlightable lines of ${lines} | expected: fewer than all`
      ).toBeLessThan(lines);
      expect(
        countHighlightableLines(source, 'html'),
        `html highlightable lines of ${lines} | expected: all`
      ).toBe(lines);
    });
  }

  interface Registration {
    readonly name?: string;
    readonly embeddedLangsLazy?: readonly string[];
  }

  /** Shipped grammars a language's registrations load or can switch into, from `@shikijs/langs`. */
  async function registeredEmbeds(language: ShikiLanguageId): Promise<ShikiLanguageId[]> {
    const module = (await import(`@shikijs/langs/${language}`)) as { default: Registration[] };
    const known = new Set<string>(SHIKI_LANGUAGE_IDS);
    const names = module.default.flatMap((registration) => [
      registration.name ?? '',
      ...(registration.embeddedLangsLazy ?? []),
    ]);
    const ids = names.map((name) => (name === 'shellscript' ? 'bash' : name));
    return [...new Set(ids)]
      .filter((id) => known.has(id) && id !== language)
      .sort() as ShikiLanguageId[];
  }

  it('lists, for each grammar, the shipped grammars its registration loads or embeds', async () => {
    for (const language of SHIKI_LANGUAGE_IDS) {
      expect(
        [...(EMBEDDED_LANGUAGES[language] ?? [])].sort(),
        `grammars ${language} embeds, per EMBEDDED_LANGUAGES`
      ).toEqual(await registeredEmbeds(language));
    }
  });
});
