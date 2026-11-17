import {
  codeToHast,
  type CodeToHastOptions,
  codeToTokens,
  codeToTokensBase,
  hastToHtml,
  type HighlighterCore,
  type ThemedToken,
  tokensToHast,
} from '@shikijs/core';

type Grammar = ReturnType<HighlighterCore['getLanguage']>;

class IncompleteTokenizationError extends Error {
  constructor() {
    super('Incomplete syntax highlighting: tokenizer stopped before the line ended');
    this.name = 'IncompleteTokenizationError';
  }
}

export interface CheckedRenderers {
  readonly codeToTokensBase: HighlighterCore['codeToTokensBase'];
  /**
   * Serializes each line of tokens the caller already holds to its own `<span class="line">`, so
   * a block that grows keeps the HTML of the lines it has and draws only the new ones.
   */
  readonly tokenLinesToHtml: (tokens: ThemedToken[][], options: TokensToHtmlOptions) => string[];
  /** Wraps serialized lines in the `<pre><code>` Shiki draws around a block. */
  readonly htmlFromLines: (lines: readonly string[], options: TokensToHtmlOptions) => string;
}

interface TokensToHtmlOptions {
  readonly lang: string;
  readonly theme: string;
}

/**
 * Rejects partial tokenization before Shiki turns it into apparently complete output.
 * `observeLine` sees each line before it is tokenized; tests use it to count tokenizer work.
 * Example: createCheckedRenderers(highlighter).codeToTokensBase(code, options).
 */
export function createCheckedRenderers(
  highlighter: HighlighterCore,
  observeLine?: (line: string) => void
): CheckedRenderers {
  const grammars = new WeakMap<Grammar, Grammar>();
  const primitive = {
    ...highlighter,
    getLanguage(name: Parameters<HighlighterCore['getLanguage']>[0]): Grammar {
      const grammar = highlighter.getLanguage(name);
      const existing = grammars.get(grammar);
      if (existing) return existing;

      const checked = Object.create(grammar) as Grammar;
      checked.tokenizeLine2 = (...args: Parameters<Grammar['tokenizeLine2']>) => {
        observeLine?.(args[0]);
        const result = grammar.tokenizeLine2(...args);
        if (result.stoppedEarly) throw new IncompleteTokenizationError();
        return result;
      };
      grammars.set(grammar, checked);
      return checked;
    },
  };

  return {
    codeToTokensBase: (code, options) => codeToTokensBase(primitive, code, options),
    tokenLinesToHtml: (tokens, options) => {
      const code = codeElementOf(buildHast(tokens, options));
      return code.children.flatMap((child) =>
        child.type === 'element' ? [hastToHtml({ type: 'root', children: [child] })] : []
      );
    },
    htmlFromLines: (lines, options) => {
      const frame = hastToHtml(buildHast([], options));
      // The frame of an empty block is `<pre ...><code></code></pre>`, so the first `</code>` is its own.
      const insertAt = frame.indexOf('</code>');
      return `${frame.slice(0, insertAt)}${lines.join('\n')}${frame.slice(insertAt)}`;
    },
  };

  function buildHast(tokens: ThemedToken[][], options: TokensToHtmlOptions) {
    const theme = primitive.getTheme(options.theme);
    const context = {
      meta: {},
      options,
      // No transformer runs here, so the source is never read; the context only has to be whole.
      source: '',
      codeToHast: (code: string, hastOptions: CodeToHastOptions) =>
        codeToHast(primitive, code, hastOptions),
      codeToTokens: (code: string, tokenOptions: Parameters<typeof codeToTokens>[2]) =>
        codeToTokens(primitive, code, tokenOptions),
    };
    return tokensToHast(
      tokens,
      { ...options, fg: theme.fg, bg: theme.bg, themeName: theme.name },
      context
    );
  }
}

/** The `<code>` element of Shiki's `<pre><code>` tree. */
function codeElementOf(root: ReturnType<typeof tokensToHast>) {
  const pre = root.children[0];
  const code = pre?.type === 'element' ? pre.children[0] : undefined;
  if (code?.type !== 'element') throw new Error('Shiki produced no <pre><code> tree');
  return code;
}
