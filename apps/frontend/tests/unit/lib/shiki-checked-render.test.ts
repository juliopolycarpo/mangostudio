import { beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { CODE_THEMES, initHighlighter, preloadCodeLanguages } from '@/lib/shiki';
import { createCheckedRenderers } from '@/lib/shiki-checked-render';

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

let highlighter: Awaited<ReturnType<typeof initHighlighter>>;

beforeAll(async () => {
  await preloadCodeLanguages(Object.keys(SAMPLES));
  highlighter = await initHighlighter();
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
          observations.push({
            checkedHtml: checked.codeToHtml(source, options),
            rawHtml: highlighter.codeToHtml(source, options),
            checkedTokens: checked.codeToTokensBase(source, options),
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
