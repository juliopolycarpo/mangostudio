import { describe, expect, it } from 'bun:test';

import { contentHasCodeFence } from '@/lib/code-highlighter-preload';

describe('contentHasCodeFence', () => {
  const cases: readonly [string, string, boolean][] = [
    ['a backtick fence', '```ts\nconst a = 1;\n```', true],
    ['a tilde fence', 'text\n\n~~~bash\necho hi\n~~~', true],
    ['a fence indented by three spaces', 'list\n   ```js\n   x\n   ```', true],
    ['prose only', 'No code here, just `inline` code.', false],
    ['a fence indented by four spaces (an indented code block)', '    ```js', false],
    ['backticks in the middle of a line', 'use ``` to open a block', false],
    ['an empty string', '', false],
  ];
  for (const [name, content, expected] of cases) {
    it(`${expected ? 'detects' : 'ignores'} ${name}`, () => {
      expect(contentHasCodeFence(content), `content: ${JSON.stringify(content)}`).toBe(expected);
    });
  }
});
