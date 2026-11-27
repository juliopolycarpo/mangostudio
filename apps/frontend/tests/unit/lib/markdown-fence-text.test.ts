import { describe, expect, it } from 'bun:test';

import { Lexer, type Token } from 'marked';

import { createParser, MARKDOWN_LEXER_OPTIONS } from '../../../src/lib/markdown-parser';

// Each source pairs with the block text the chat draws: the fence content without its final
// line break, so a trailing blank line inside the fence is one empty line, not two.
const FENCES: readonly (readonly [string, string])[] = [
  ['```ts\na\n```', 'a'],
  ['```ts\na\n\n```', 'a\n'],
  ['```ts\na\n\n\n```', 'a\n\n'],
  ['```ts\n\n```', ''],
  ['~~~\na\n\n~~~', 'a\n'],
  ['  ```ts\n  a\n\n  ```', 'a\n'],
  ['```ts\na\n \n```', 'a\n '],
  // Still streaming: no closing fence yet.
  ['```ts\na\n', 'a'],
  ['```ts\na\n\n', 'a\n'],
];

function fenceText(tokens: readonly Token[]): string {
  const [token] = tokens;
  if (token?.type !== 'code') {
    throw new Error(`expected a code token first | received: ${JSON.stringify(token?.type)}`);
  }
  return token.text;
}

describe('fenced code text', () => {
  it.each(FENCES)('the shared lexer reads %j as %j', (source, text) => {
    expect(fenceText(Lexer.lex(source, MARKDOWN_LEXER_OPTIONS))).toBe(text);
  });

  it.each(FENCES)('the chat parser reads %j as %j', (source, text) => {
    expect(fenceText(createParser('one-dark-pro', 'Copy', null).lexer(source))).toBe(text);
  });
});
