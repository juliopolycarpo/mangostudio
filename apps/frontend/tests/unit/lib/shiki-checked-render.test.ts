import { beforeAll, describe, expect, it, spyOn } from 'bun:test';

import { CODE_THEMES, initHighlighter, preloadCodeLanguages } from '@/lib/shiki';
import { createCheckedRenderers } from '@/lib/shiki-checked-render';

import { pinTokenizerClockPerTest } from '../../support/harness/pinned-tokenizer-clock';
import { frozenTokenizerClock, withTokenizerClock } from '../../support/mocks/fake-tokenizer-clock';

const SAMPLES = {
  bash: 'echo "$PATH"',
  c: 'int main(void) { return 0; }',
  cpp: 'std::vector<int> values;',
  csharp: 'public class Example {}',
  css: '.x { color: red; }',
  go: 'package main\nfunc main() {}',
  html: '<p title="hi">Hello</p>',
  java: 'public class Example {}',
  javascript: 'const value = 42;',
  json: '{"value":42}',
  jsx: 'const App = () => <div />;',
  markdown: '# Heading\n**text**',
  php: '<?php echo "hi";',
  powershell: 'Write-Host "Hello"',
  python: 'def greet():\n  return "Hello"',
  ruby: 'puts "Hello"',
  rust: 'fn main() { println!("hello"); }',
  sql: 'SELECT 1 AS value;',
  swift: 'let value = 42',
  tsx: 'const App = (): JSX.Element => <div />;',
  typescript: 'const value: number = 42; // café <tag>',
  xml: '<root name="Hello" />',
  yaml: 'value: 42',
} as const;

pinTokenizerClockPerTest();

let highlighter: Awaited<ReturnType<typeof initHighlighter>>;

beforeAll(async () => {
  await preloadCodeLanguages(Object.keys(SAMPLES), 'one-dark-pro');
  highlighter = await initHighlighter();
  // The cases below colour every theme, and only the requested one is loaded by default.
  for (const theme of CODE_THEMES) await highlighter.loadTheme(theme);
});

function unchangedClock(): number {
  return 0;
}

describe('checked Shiki renderer', () => {
  for (const language of Object.keys(SAMPLES) as (keyof typeof SAMPLES)[]) {
    const source = SAMPLES[language];
    it(`preserves complete ${language} HTML and every token field in all themes`, () => {
      const checked = createCheckedRenderers(highlighter);
      const originalClock = Date.now;
      const observations = [];
      try {
        // This isolates complete-output parity from the separately tested cooperative deadline.
        Date.now = unchangedClock;
        for (const theme of CODE_THEMES) {
          const options = { lang: language, theme, tokenizeTimeLimit: 500 };
          const checkedTokens = checked.codeToTokensBase(source, options);
          observations.push({
            // Serialized line by line and framed again, as a growing block is; without
            // whitespace merging, which the token path does not do.
            checkedHtml: checked.htmlFromLines(
              checked.tokenLinesToHtml(checkedTokens, options),
              options
            ),
            rawHtml: highlighter.codeToHtml(source, { ...options, mergeWhitespaces: false }),
            checkedTokens,
            rawTokens: highlighter.codeToTokensBase(source, options),
          });
        }
      } finally {
        Date.now = originalClock;
      }
      for (const result of observations) {
        expect(result.checkedHtml).toBe(result.rawHtml);
        expect(result.checkedTokens).toEqual(result.rawTokens);
      }
    });
  }

  it('matches Shiki codeToHtml on a multi-construct block, except for whitespace tokens', () => {
    // Strings with escapes, a template literal across lines, comments, regexes, JSX-free generics.
    const source = [
      "import { a } from './a';",
      '',
      '/** Doc <b>comment</b> & more. */',
      'export async function load<T extends object>(input: T, ...rest: string[]): Promise<T> {',
      '  const pattern = /^(?<name>[a-z]+)\\d{2,}$/giu; // trailing',
      `  const text = \`first \${input} line`,
      `  second \${rest.join(", ")} line\`;`,
      "  return { ...input, text, quote: 'it\\'s', tab: '\\t' } as T;",
      '}',
      '',
    ].join('\n');
    const options = { lang: 'typescript', theme: 'one-dark-pro' };
    const checked = createCheckedRenderers(highlighter);
    // Equality with Shiki is the claim, so time must not matter: on a slow runner a cold regex
    // compile passes the real 500 ms limit and the checked renderer throws
    // IncompleteTokenizationError instead of returning coarser tokens.
    const { ours, shiki } = withTokenizerClock(frozenTokenizerClock, () => ({
      ours: checked.htmlFromLines(
        checked.tokenLinesToHtml(checked.codeToTokensBase(source, options), options),
        options
      ),
      shiki: highlighter.codeToHtml(source, options),
    }));

    // The DOM parser decodes entities and drops tags; stripping tags with a regex would not be a
    // faithful reading of what the browser shows.
    const textOf = (html: string) => {
      const holder = document.createElement('div');
      holder.innerHTML = html;
      return holder.textContent;
    };
    // Shiki's own HTML merges a whitespace-only token into the next one; ours keeps it as a
    // token. Both are drawn identically, so compare the coloured tokens with their blanks removed.
    const colouredTokens = (html: string) =>
      [...html.matchAll(/<span style="([^"]*)">([^<]*)<\/span>/g)]
        .map(([, style, text]) => `${style}|${text?.trim()}`)
        .filter((token) => !token.endsWith('|'));

    expect(textOf(ours), 'text content of the serialized block').toBe(textOf(shiki));
    expect(ours.match(/class="line"/g)?.length, 'line spans').toBe(
      shiki.match(/class="line"/g)?.length
    );
    expect(ours.slice(0, ours.indexOf('<code>')), 'the <pre> frame').toBe(
      shiki.slice(0, shiki.indexOf('<code>'))
    );
    expect(colouredTokens(ours), 'coloured tokens, blanks trimmed').toEqual(colouredTokens(shiki));
  });

  it('preserves the tokenizer receiver and arguments without changing the original grammar', () => {
    const grammar = highlighter.getLanguage('typescript');
    const original = grammar.tokenizeLine2;
    const calls: { receiver: unknown; args: Parameters<typeof original> }[] = [];
    const tokenizer = spyOn(grammar, 'tokenizeLine2').mockImplementation(function (
      this: typeof grammar,
      ...args
    ) {
      calls.push({ receiver: this, args });
      return original.apply(this, args);
    });
    const before = Object.getOwnPropertyDescriptors(grammar);
    const checked = createCheckedRenderers(highlighter);
    try {
      checked.codeToTokensBase('const value = 1;', {
        lang: 'typescript',
        theme: 'one-dark-pro',
        tokenizeTimeLimit: 500,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.receiver).toBe(grammar);
      expect(calls[0]?.args[0]).toBe('const value = 1;');
      expect(calls[0]?.args[2]).toBe(500);
      expect(Object.getOwnPropertyDescriptors(grammar)).toEqual(before);
    } finally {
      tokenizer.mockRestore();
    }
    expect(grammar.tokenizeLine2).toBe(original);
  });
});
