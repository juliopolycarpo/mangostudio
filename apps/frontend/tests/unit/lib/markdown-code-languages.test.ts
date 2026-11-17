import { describe, expect, it } from 'bun:test';

import { Lexer } from 'marked';

import { collectCodeFences, detectCodeLanguages } from '../../../src/lib/markdown-code-languages';
import { MARKDOWN_LEXER_OPTIONS } from '../../../src/lib/markdown-parser';

function languagesOf(text: string): string[] {
  return detectCodeLanguages(Lexer.lex(text, MARKDOWN_LEXER_OPTIONS));
}

describe('detectCodeLanguages', () => {
  it('returns the grammar ids of closed and open fences, sorted and without repeats', () => {
    expect(languagesOf('```ts\na\n```\n\n```py\nb\n```\n\n```typescript\nc\n```\n')).toEqual([
      'python',
      'typescript',
    ]);
  });

  it('ignores a fence whose info line is still arriving', () => {
    expect(languagesOf('text\n\n```ts')).toEqual([]);
    expect(languagesOf('text\n\n```ts\n')).toEqual(['typescript']);
  });

  it('ignores a language the highlighter has no grammar for', () => {
    expect(languagesOf('```cobol\nx\n```\n')).toEqual([]);
  });

  it('finds fences nested in a list item and in a quote', () => {
    expect(
      languagesOf('- item\n\n  ```bash\n  ls\n  ```\n\n> ```rust\n> fn main() {}\n> ```\n')
    ).toEqual(['bash', 'rust']);
  });

  it('follows fences written inside a markdown block', () => {
    expect(languagesOf('````md\n```python\nx\n```\n````\n')).toEqual(['markdown', 'python']);
  });

  it('gives the same answer for a token it has already scanned', () => {
    const tokens = Lexer.lex('```go\nx\n```\n\nplain', MARKDOWN_LEXER_OPTIONS);

    expect(detectCodeLanguages(tokens)).toEqual(['go']);
    expect(detectCodeLanguages(tokens)).toEqual(['go']);
  });
});

describe('collectCodeFences', () => {
  it('lists each fence with its text and info string, nested ones included', () => {
    const tokens = Lexer.lex(
      '```ts\nlet a;\n```\n\n- item\n\n  ```py\n  b = 1\n  ```\n\n> ```cobol\n> x\n> ```\n',
      MARKDOWN_LEXER_OPTIONS
    );
    expect(collectCodeFences(tokens)).toEqual([
      { text: 'let a;', lang: 'ts' },
      { text: 'b = 1', lang: 'py' },
      { text: 'x', lang: 'cobol' },
    ]);
  });

  it('skips a fence without an info string, which is never highlighted', () => {
    expect(collectCodeFences(Lexer.lex('```\nplain\n```\n', MARKDOWN_LEXER_OPTIONS))).toEqual([]);
  });

  it('lists a markdown fence once, without the fences written inside it', () => {
    const tokens = Lexer.lex('````md\n```ts\nlet a;\n```\n````\n', MARKDOWN_LEXER_OPTIONS);
    expect(collectCodeFences(tokens).map((fence) => fence.lang)).toEqual(['md']);
  });
});
