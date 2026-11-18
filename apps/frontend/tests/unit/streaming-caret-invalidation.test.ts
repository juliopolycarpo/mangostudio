/**
 * The streaming caret's selectors must end in a tag.
 *
 * `.markdown-content--streaming` comes off the message root when a reply ends. Chrome decides
 * what that class change restyles from the last compound of every selector that mentions it: a
 * bare `:last-child`, `*` or `:is(...)` there means "any element", so the browser restyles the
 * whole subtree. On a 100 KB answer (19,000 elements, most of them code-token spans) that was a
 * 160 ms task at the end of every long stream; with a tag in that position it is 11 ms. Nothing
 * fails visibly when someone folds the lists back into `:is()`, so the guard is here.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MARKDOWN_CSS = join(import.meta.dir, '../../src/styles/markdown-content.css');
const STREAMING_CLASS = 'markdown-content--streaming';

/** Splits on the commas outside parentheses and brackets. */
function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** The text after the last combinator outside parentheses: the compound Chrome keys on. */
function lastCompound(selector: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (depth === 0 && (char === ' ' || char === '>' || char === '+' || char === '~'))
      start = i + 1;
  }
  return selector.slice(start).trim();
}

/**
 * Selectors that mention the streaming class and whose last compound does not start with a tag,
 * each as `selector -> compound`. Empty when the stylesheet is right.
 */
function streamingSelectorsWithoutTag(css: string): string[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const offenders: string[] = [];
  for (const match of source.matchAll(/([^{}]+)\{/g)) {
    for (const selector of splitSelectors(match[1] ?? '')) {
      if (!selector.includes(STREAMING_CLASS)) continue;
      const compound = lastCompound(selector);
      if (!/^[a-z][a-z0-9]*(?![a-z0-9-])/.test(compound))
        offenders.push(`${selector} -> ${compound}`);
    }
  }
  return offenders;
}

describe('streamingSelectorsWithoutTag', () => {
  it('flags the universal and :is() subjects the caret used before', () => {
    expect(
      streamingSelectorsWithoutTag(`
        .markdown-content--streaming > :last-child::after { content: ""; }
        .markdown-content--streaming > blockquote:last-child > :last-child::after { content: ""; }
        .markdown-content--streaming > ul:last-child > li:last-child::after { content: ""; }
        .markdown-content--streaming > :is(ul, ol, pre):last-child::after { content: none; }
      `)
    ).toEqual([
      '.markdown-content--streaming > :last-child::after -> :last-child::after',
      '.markdown-content--streaming > blockquote:last-child > :last-child::after -> :last-child::after',
      '.markdown-content--streaming > :is(ul, ol, pre):last-child::after -> :is(ul, ol, pre):last-child::after',
    ]);
  });

  it('accepts selectors that end in a tag', () => {
    expect(
      streamingSelectorsWithoutTag(`
        .markdown-content--streaming > p:last-child::after,
        .markdown-content--streaming > ul:last-child > li:last-child::after { content: ""; }
        .markdown-content--thinking { --streaming-caret-color: red; }
      `)
    ).toEqual([]);
  });
});

describe('markdown-content.css streaming caret', () => {
  it('keys every streaming-class selector on a tag, so ending a reply restyles only those blocks', () => {
    const css = readFileSync(MARKDOWN_CSS, 'utf8');
    expect(streamingSelectorsWithoutTag(css)).toEqual([]);
    // Not vacuous: the stylesheet still has the caret rule this guard is about.
    expect(css.includes(`.${STREAMING_CLASS} > p:last-child::after`)).toBe(true);
  });
});
