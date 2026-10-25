import { codeToHtml, codeToTokensBase, type HighlighterCore } from '@shikijs/core';

type Grammar = ReturnType<HighlighterCore['getLanguage']>;

class IncompleteTokenizationError extends Error {
  constructor() {
    super('Incomplete syntax highlighting: tokenizer stopped before the line ended');
    this.name = 'IncompleteTokenizationError';
  }
}

/**
 * Rejects partial tokenization before Shiki turns it into apparently complete output.
 * Example: createCheckedRenderers(highlighter).codeToHtml(code, options).
 */
export function createCheckedRenderers(
  highlighter: HighlighterCore
): Pick<HighlighterCore, 'codeToHtml' | 'codeToTokensBase'> {
  const grammars = new WeakMap<Grammar, Grammar>();
  const primitive = {
    ...highlighter,
    getLanguage(name: Parameters<HighlighterCore['getLanguage']>[0]): Grammar {
      const grammar = highlighter.getLanguage(name);
      const existing = grammars.get(grammar);
      if (existing) return existing;

      const checked = Object.create(grammar) as Grammar;
      checked.tokenizeLine2 = (...args: Parameters<Grammar['tokenizeLine2']>) => {
        const result = grammar.tokenizeLine2(...args);
        if (result.stoppedEarly) throw new IncompleteTokenizationError();
        return result;
      };
      grammars.set(grammar, checked);
      return checked;
    },
  };

  return {
    codeToHtml: (code, options) => codeToHtml(primitive, code, options),
    codeToTokensBase: (code, options) => codeToTokensBase(primitive, code, options),
  };
}
