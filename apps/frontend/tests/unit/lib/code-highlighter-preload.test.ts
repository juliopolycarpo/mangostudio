import { describe, expect, it } from 'bun:test';

import { contentNeedsCodeHighlighter } from '@/lib/code-highlighter-preload';

describe('contentNeedsCodeHighlighter', () => {
  const cases: readonly [string, string, boolean][] = [
    ['a backtick fence', '```ts\nconst a = 1;\n```', true],
    ['a tilde fence', 'text\n\n~~~bash\necho hi\n~~~', true],
    ['a fence indented by three spaces', 'list\n   ```js\n   x\n   ```', true],
    ['an alias in capitals with trailing attributes', '```TS title=a.ts\nx\n```', true],
    ['a longer fence', '````md\n```ts\nx\n```\n````', true],
    ['a fence with a windows line ending', '```ts\r\nx\r\n```', true],
    ['a supported fence after an unsupported one', '```mystery\n<a/>\n```\n\n```py\nx\n```', true],
    ['a vue fence', '```vue\n<template/>\n```', true],
    ['a svelte fence', '```svelte\n<script></script>\n```', true],
    ['prose only', 'No code here, just `inline` code.', false],
    ['a bare fence', '```\nplain text\n```', false],
    ['a bare tilde fence', '~~~\nplain text\n~~~', false],
    ['an unsupported language', '```mystery\n<template/>\n```', false],
    ['a language named like an object key', '```constructor\nx\n```', false],
    ['a fence indented by four spaces (an indented code block)', '    ```js\n    x', false],
    ['backticks in the middle of a line', 'use ``` to open a block\n', false],
    ['a backtick span that opens with three backticks', '```ts``` inline\n', false],
    ['an empty string', '', false],
  ];
  for (const [name, content, expected] of cases) {
    it(`${expected ? 'detects' : 'ignores'} ${name}`, () => {
      expect(contentNeedsCodeHighlighter(content), `content: ${JSON.stringify(content)}`).toBe(
        expected
      );
    });
  }

  // A reply streams in arbitrary slices. Until the newline that ends the info
  // line arrives, the fence has not said which language it is.
  const streamedFences: readonly [string, string, string, boolean][] = [
    ['"```ts" before the x of tsx', '```ts', '```tsx\nx', true],
    ['"```js" before the on of json', 'intro\n\n```js', 'intro\n\n```json\n{}', true],
    ['a bare opening fence still streaming', '```', '```\ncode', false],
  ];
  for (const [name, partial, complete, completeNeedsHighlighter] of streamedFences) {
    it(`waits for the info line to end: ${name}`, () => {
      expect(contentNeedsCodeHighlighter(partial), `partial: ${JSON.stringify(partial)}`).toBe(
        false
      );
      expect(contentNeedsCodeHighlighter(complete), `complete: ${JSON.stringify(complete)}`).toBe(
        completeNeedsHighlighter
      );
    });
  }
});
