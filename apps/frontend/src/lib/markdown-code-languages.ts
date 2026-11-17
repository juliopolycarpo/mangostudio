import { Lexer, Marked, type Token } from 'marked';

import { resolveLanguageId } from '@/lib/code-languages';
import { MARKDOWN_LEXER_OPTIONS } from '@/lib/markdown-parser';

// `walkTokens` is an instance method; this one has no renderer or extensions to run.
const tokenWalker = new Marked();

// A markdown block can nest markdown blocks; stop descending past this.
const MAX_EMBEDDED_MARKDOWN_DEPTH = 3;

/**
 * What each top-level token asks for, so a streamed message scans the tokens that changed and
 * not all of them: the lexer hands back the same token objects for the settled part of the text.
 */
const languagesByToken = new WeakMap<Token, readonly string[]>();

/**
 * The fence languages in `tokens` that need a grammar, sorted. A fence counts once its info
 * line is complete: while a reply streams, "```ts" can be all that has arrived of "```tsx", and
 * loading the wrong grammar is a wasted download. A markdown block also counts the fences
 * written inside it, because the markdown grammar highlights those with their own grammars.
 */
// Usage: detectCodeLanguages(Lexer.lex(text, MARKDOWN_LEXER_OPTIONS)) // ['typescript']
export function detectCodeLanguages(tokens: readonly Token[]): string[] {
  const languages = new Set<string>();
  for (const token of tokens) {
    let found = languagesByToken.get(token);
    if (found === undefined) {
      const own = new Set<string>();
      collectFromTokens([token], own, 0);
      found = [...own];
      languagesByToken.set(token, found);
    }
    for (const language of found) languages.add(language);
  }
  return [...languages].sort();
}

function collectFromTokens(tokens: Token[], languages: Set<string>, depth: number): void {
  // walkTokens recurses into list items and blockquotes, so fenced code nested
  // inside them still has its grammar preloaded for highlighting.
  // This callback is synchronous, so there are no pending token visits to await.
  void tokenWalker.walkTokens(tokens, (token) => {
    if (token.type !== 'code' || !('lang' in token) || !token.lang) return;
    // A fenced token's raw text is its opening line, so a newline after the info
    // string says the line is complete. Without one the fence is still arriving.
    if (!token.raw.includes('\n')) return;
    // Collect the grammar id, not the info string: a fence the highlighter has no
    // grammar for must not start the Shiki chunk, and `ts` and `typescript` are one grammar.
    const language = resolveLanguageId(token.lang);
    if (language === null) return;
    languages.add(language);
    if (language === 'markdown' && depth < MAX_EMBEDDED_MARKDOWN_DEPTH && token.text) {
      collectFromTokens(Lexer.lex(token.text, MARKDOWN_LEXER_OPTIONS), languages, depth + 1);
    }
  });
}
