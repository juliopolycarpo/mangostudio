import { afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import {
  highlightCode,
  highlightLineTokens,
  initHighlighter,
  preloadCodeLanguages,
} from '@/lib/shiki';

type Highlighter = Awaited<ReturnType<typeof initHighlighter>>;
type Grammar = ReturnType<Highlighter['getLanguage']>;

let highlighter: Highlighter;
let restoreTokenizer: (() => void) | undefined;

beforeAll(async () => {
  await preloadCodeLanguages(['ts', 'cpp']);
  highlighter = await initHighlighter();
});

afterEach(() => {
  restoreTokenizer?.();
  restoreTokenizer = undefined;
});

/** Flags a real tokenizer result without changing its otherwise complete token data. */
class EarlyStopTokenizer {
  calls: Parameters<Grammar['tokenizeLine2']>[] = [];

  constructor(
    private readonly grammar: Grammar,
    private readonly original: Grammar['tokenizeLine2'],
    private readonly stopOn: number
  ) {}

  tokenize = (...args: Parameters<Grammar['tokenizeLine2']>) => {
    this.calls.push(args);
    const result = this.original.apply(this.grammar, args);
    return { ...result, stoppedEarly: this.calls.length === this.stopOn };
  };
}

function stopTokenizationOn(call: number): EarlyStopTokenizer {
  const grammar = highlighter.getLanguage('typescript');
  const fake = new EarlyStopTokenizer(grammar, grammar.tokenizeLine2, call);
  const tokenizer = spyOn(grammar, 'tokenizeLine2').mockImplementation(fake.tokenize);
  restoreTokenizer = () => tokenizer.mockRestore();
  return fake;
}

describe('incomplete highlighting', () => {
  it('preserves common-language initialization, aliases and unsupported-language fallback', async () => {
    expect(highlighter.getLoadedLanguages()).toEqual(
      expect.arrayContaining([
        'typescript',
        'javascript',
        'tsx',
        'jsx',
        'json',
        'bash',
        'python',
        'markdown',
      ])
    );
    const realNow = Date.now;
    const results = [];
    try {
      // Alias resolution is independent of the cooperative deadline tested below.
      Date.now = unchangedClock;
      for (const alias of [
        'ts',
        'TS',
        '  typescript extra-info ',
        'js',
        'mjs',
        'py',
        'sh',
        'shell',
        'zsh',
      ]) {
        results.push({ alias, html: highlightCode('value', alias, 'one-dark-pro') });
      }
    } finally {
      Date.now = realNow;
    }
    for (const result of results)
      expect(result).toEqual({ alias: result.alias, html: expect.stringContaining('shiki') });
    expect(highlightCode('value', '', 'one-dark-pro')).toBeNull();
    expect(highlightLineTokens('value', 'unsupported-language', 'one-dark-pro')).toBeNull();
    await expect(preloadCodeLanguages(['unsupported-language'])).resolves.toBe(false);
  });

  it('shares concurrent grammar loads and cleans up a rejected load for an explicit retry', async () => {
    const loading = spyOn(highlighter, 'loadLanguage');
    try {
      await Promise.all([preloadCodeLanguages(['xml']), preloadCodeLanguages(['xml', 'go'])]);
      expect(loading.mock.calls.filter(([language]) => language === 'xml')).toHaveLength(1);
      expect(loading.mock.calls.filter(([language]) => language === 'go')).toHaveLength(1);

      loading.mockImplementationOnce(failLanguageLoad);
      await expect(preloadCodeLanguages(['ruby'])).rejects.toThrow(
        'Synthetic language module download failure'
      );
      await expect(preloadCodeLanguages(['ruby'])).resolves.toBe(true);
      expect(loading.mock.calls.filter(([language]) => language === 'ruby')).toHaveLength(2);
      expect(highlightCode('puts "hi"', 'rb', 'one-dark-pro')).toContain('shiki');
    } finally {
      loading.mockRestore();
    }
  });

  it('rejects stopped HTML even when the partial token colors happen to match', () => {
    const tokenizer = stopTokenizationOn(1);
    expect(highlightCode('const value = 42;', 'ts', 'one-dark-pro')).toBeNull();
    expect(tokenizer.calls).toHaveLength(1);
    expect(tokenizer.calls[0]?.[2]).toBe(500);
  });

  it('rejects stopped diff tokens with the same per-line budget', () => {
    const tokenizer = stopTokenizationOn(1);
    expect(highlightLineTokens('const value = 42;', 'ts', 'one-dark-pro')).toBeNull();
    expect(tokenizer.calls).toHaveLength(1);
    expect(tokenizer.calls[0]?.[2]).toBe(500);
  });

  it('rejects a whole multiline block when a later line stops, then recovers independently', () => {
    const tokenizer = stopTokenizationOn(2);
    expect(
      highlightCode('const first = 1;\nconst second = 2;\nconst third = 3;', 'ts', 'one-dark-pro')
    ).toBeNull();
    expect(tokenizer.calls).toHaveLength(2);
    expect(highlightCode('const complete = 3;', 'ts', 'one-dark-pro')).toContain('shiki');
    expect(tokenizer.calls).toHaveLength(3);
  });

  it('keeps engine failures nullable and permits a later independent render', () => {
    const grammar = highlighter.getLanguage('typescript');
    const tokenizer = spyOn(grammar, 'tokenizeLine2').mockImplementationOnce(failTokenization);
    restoreTokenizer = () => tokenizer.mockRestore();
    expect(highlightCode('const value = 42;', 'ts', 'one-dark-pro')).toBeNull();
    expect(highlightCode('const value = 42;', 'ts', 'one-dark-pro')).toContain('shiki');
  });

  for (const language of ['typescript', 'cpp'] as const) {
    it(`rejects a real ${language} tokenizer stop driven by a scoped clock`, () => {
      const source = 'const value = 42; // café <tag>';
      const grammar = highlighter.getLanguage(language);
      const original = grammar.tokenizeLine2;
      const stops: boolean[] = [];
      const tokenizer = spyOn(grammar, 'tokenizeLine2').mockImplementation(function (
        this: Grammar,
        ...args
      ) {
        const result = original.apply(this, args);
        stops.push(result.stoppedEarly);
        return result;
      });
      restoreTokenizer = () => tokenizer.mockRestore();

      for (const render of [highlightCode, highlightLineTokens]) {
        const clock = new TokenizationBudgetClock();
        const realNow = Date.now;
        let result: ReturnType<typeof render>;
        try {
          Date.now = clock.now;
          result = render(source, language, 'one-dark-pro');
        } finally {
          Date.now = realNow;
        }
        expect(stops.at(-1)).toBe(true);
        expect(result).toBeNull();
      }
      expect(highlightCode(source, language, 'one-dark-pro')).toContain('shiki');
      expect(stops.at(-1)).toBe(false);
    });
  }
});

function failTokenization(): never {
  throw new Error('Synthetic regex-engine failure');
}

function failLanguageLoad(): Promise<void> {
  return Promise.reject(new Error('Synthetic language module download failure'));
}

function unchangedClock(): number {
  return 0;
}

class TokenizationBudgetClock {
  private ticks = 0;
  now = () => (++this.ticks <= 4 ? 0 : 1_000);
}
