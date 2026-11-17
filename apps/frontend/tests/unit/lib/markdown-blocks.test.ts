import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Lexer } from 'marked';
import type { Marked } from 'marked';

import { SHIKI_LANGUAGE_IDS } from '../../../src/lib/code-languages';
import {
  BlockDomMirror,
  IncrementalBlockRenderer,
  IncrementalLexer,
  stableBoundary,
} from '../../../src/lib/markdown-blocks';
import { createParser, MARKDOWN_LEXER_OPTIONS } from '../../../src/lib/markdown-parser';

/** The lexer and the renderer wired the way `MarkdownContentRenderer` wires them. */
class IncrementalMarkdown {
  readonly lexer = new IncrementalLexer(MARKDOWN_LEXER_OPTIONS);
  readonly renderer: IncrementalBlockRenderer;

  constructor(parser: Marked) {
    this.renderer = new IncrementalBlockRenderer(parser);
  }

  blocks(content: string): readonly string[] {
    return this.renderer.render(this.lexer.update(content));
  }

  get lastStats() {
    return { ...this.lexer.lastStats, renderedTokens: this.renderer.lastRenderedCount };
  }
}

const REPOSITORY_DOCS = join(import.meta.dir, '../../../../../docs');

/** Deterministic colouring that depends only on the code, like Shiki's output for a finished block. */
const lineWrappingHighlighter = {
  highlightCode: (code: string, lang: string) =>
    lang === 'plain-none'
      ? null
      : `<pre class="shiki" data-x="${lang.length}"><code>${code
          .split('\n')
          .map((line) => `<span class="line">${line.replaceAll('<', '&lt;')}</span>`)
          .join('\n')}</code></pre>`,
  preloadCodeLanguages: () => Promise.resolve(true),
};

function newParser() {
  return createParser('one-dark-pro', 'Copy', lineWrappingHighlighter);
}

/** mulberry32: a seeded generator, so a failing stream replays from its seed. */
function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every prefix length a random chunking of `length` characters lands on, ending at `length`. */
function chunkEnds(length: number, maxChunk: number, random: () => number): number[] {
  const ends: number[] = [];
  let at = 0;
  while (at < length) {
    at = Math.min(length, at + 1 + Math.floor(random() * maxChunk));
    ends.push(at);
  }
  return ends;
}

interface StreamFailure {
  readonly name: string;
  readonly seed: number;
  readonly prefixLength: number;
  readonly expected: string;
  readonly received: string;
}

/** Streams `text` and returns the first prefix whose blocks differ from a from-scratch parse. */
function firstDivergence(
  name: string,
  text: string,
  seed: number,
  maxChunk: number
): StreamFailure | null {
  const parser = newParser();
  const engine = new IncrementalMarkdown(parser);
  for (const end of chunkEnds(text.length, maxChunk, createSeededRandom(seed))) {
    const prefix = text.slice(0, end);
    const received = engine.blocks(prefix).join('');
    const expected = parser.parse(prefix, { async: false });
    if (received !== expected) {
      return { name, seed, prefixLength: end, expected, received };
    }
  }
  return null;
}

function describeFailure(failure: StreamFailure): string {
  return (
    `(${failure.name}, seed ${failure.seed}): prefix of ${failure.prefixLength} chars rendered ` +
    `differently from a from-scratch parse\n  expected: ${JSON.stringify(failure.expected.slice(-300))}` +
    `\n  received: ${JSON.stringify(failure.received.slice(-300))}`
  );
}

const fenceForEachLanguage = [...SHIKI_LANGUAGE_IDS, 'ts', 'py', 'plain-none', 'unknown-lang']
  .map((lang) => `\`\`\`${lang}\nline one <b>\nline two\n\n  indented\n\`\`\`\n\nafter ${lang}\n`)
  .join('\n');

/** Each entry is one trap from the design: something a later chunk can use to change an earlier block. */
const CRAFTED_DOCUMENTS: Readonly<Record<string, string>> = {
  'paragraphs and inline':
    'First **bold** paragraph.\n\nSecond `code` with a [link](https://a.example).\n\nThird.\n',
  'reference link defined at the end':
    'See [the docs][docs] and [other] too.\n\nMiddle paragraph.\n\n[docs]: https://docs.example "Docs"\n[other]: https://other.example\n',
  'reference definition between blocks':
    'Intro [x].\n\n[x]: https://x.example\n\nOutro [x] and [y].\n\n[y]: <https://y.example>\n',
  'reference definition directly after a paragraph': 'Para [z]\n[z]: https://z.example\n\nMore.\n',
  'setext heading': 'Title line\n=========\n\nSub line\n---------\n\nplain\n',
  'setext underline after a long paragraph':
    'one\ntwo\nthree\n---\n\nNot a heading\n\n---\n\nrule above\n',
  'lazy continuation of a quote': '> quoted\nlazy line\n> more\n\nafter quote\n',
  'lazy continuation of a list':
    '- item one\ncontinues here\n- item two\n\n  second paragraph of two\n\nend\n',
  'list continued across blank lines': '1. a\n\n   b\n\n2. c\n\n\n   d\n\nplain\n',
  'nested lists':
    '- a\n  - b\n    - c\n      1. d\n      2. e\n  - f\n- g\n\n  para in g\n\nafter\n',
  'task list': '- [ ] todo\n- [x] done\n  - [ ] nested\n\nnext\n',
  'paragraph that becomes a table':
    'a | b\n\nnot yet\n\nh1 | h2\n--- | ---\nc1 | c2\nc3 | c4\n\nend\n',
  'table row appended': '| h1 | h2 |\n| --- | :-: |\n| a | b |\n| c | d |\n\ntail\n',
  'table without leading pipes': 'x | y\n- | -\n1 | 2\n\nz\n',
  'unclosed fence swallows the rest':
    'before\n\n```ts\nconst a = 1;\n\n# not a heading\n- not a list\n',
  'closed then reopened fence': '```js\na\n```\n\n~~~py\nb\n\n~~~\n\n````md\n```inner\n````\n',
  'indented code': 'para\n\n    code one\n\n    code two\n\nafter\n',
  'fence inside a list': '- item\n\n  ```bash\n  echo hi\n\n  echo bye\n  ```\n\n- next\n',
  'fence marker split': 'text\n``\n`\n```\nx\n```\n\nafter ``` inline\n',
  'html block types':
    '<div>\nhi *there*\n\nstill html?\n</div>\n\n<!-- comment\n\nstill comment -->\n\npara\n\n<pre>\n\nraw\n</pre>\n\n<script>\nalert(1)\n</script>\n',
  'html with injection':
    '<img src=x onerror=alert(1)>\n\ntext <img src=x onerror=alert(2)> inline\n\n[a<img src=y onerror=alert(3)>](javascript:alert(4))\n\n[b](jav\tascript:alert(5))\n\n![i](data:text/html,x)\n',
  'headings and rules': '# h1\n\n## h2 ##\n\n###### h6\n\n***\n\n___\n',
  'crlf line endings':
    'line one\r\nline two\r\n\r\n```ts\r\ncode\r\n\r\nmore\r\n```\r\n\r\n- a\r\n- b\r\n\r\n[r]: https://r.example\r\n',
  'lone carriage returns': 'a\rb\r\rc\r- x\r- y\r',
  'surrogate pairs':
    'emoji 😀 and 𝒳 mathematical\n\n- 🎉 item\n\n```ts\nconst s = "😀";\n```\n\n> 🧪 quote\n',
  'many blank lines': 'a\n\n\n\n\nb\n\n\n\n```\nc\n\n\n\n```\n\n\n\n',
  'blockquote with nested list and code': '> - a\n>   > b\n>\n> ```\n> code\n> ```\n\nafter\n',
  'footnote-like syntax': 'Text[^1] here.\n\n[^1]: The note.\n\nMore text.\n',
  'strikethrough, autolinks, hard breaks':
    '~~gone~~ www.example.com and <https://a.example>\nsecond line  \nthird\n',
  'escapes and entities': '\\*not em\\* &amp; &lt;b&gt; &copy; 1 < 2 > 0\n\n\\# not heading\n',
  'text only without trailing newline': 'no newline at all',
  'only blank lines': '\n\n\n',
  'every shipped language': fenceForEachLanguage,
};

/** Lines that start, continue, interrupt or end each block kind, so random sequences hit the seams. */
const LINE_FRAGMENTS = [
  '',
  '',
  '',
  'plain words',
  'more words here',
  '# heading',
  '## h2 ##',
  '---',
  '===',
  '***',
  '- item',
  '* item',
  '+ item',
  '1. one',
  '2. two',
  '2.',
  '2',
  '  continued',
  '    indented',
  '   ',
  '> quote',
  '>',
  '> > deep',
  '```',
  '```ts',
  '~~~',
  '````',
  '| a | b |',
  '| --- | --- |',
  'x | y',
  '- | -',
  '<div>',
  '</div>',
  '<!-- c',
  '-->',
  '<pre>',
  '[ref]: https://r.example',
  '[ref]',
  '[other]: <https://o.example> "T"',
  'text [ref] and [other][ref]',
  '[^1]: note',
  '- [ ] task',
  '- [x] done',
  '  - nested',
  '\t- tab',
  '😀 emoji',
  'a  ',
  'trailing \\',
  '<img src=x onerror=alert(1)>',
  '[l](javascript:alert(1))',
  '&amp; &copy;',
  '`code`',
  '**b',
];

describe('IncrementalMarkdown', () => {
  describe('every streamed prefix renders like a from-scratch parse', () => {
    for (const [name, text] of Object.entries(CRAFTED_DOCUMENTS)) {
      it(`crafted document: ${name}, one character at a time`, () => {
        const failure = firstDivergence(name, text, 1, 1);
        if (failure) throw new Error(describeFailure(failure));
      });

      it(`crafted document: ${name}, random chunks`, () => {
        for (const seed of [11, 12, 13, 14, 15, 16]) {
          const failure = firstDivergence(name, text, seed, 9);
          if (failure) throw new Error(describeFailure(failure));
        }
      });
    }

    const repositoryDocuments = readRepositoryDocuments();
    for (const { path, text } of repositoryDocuments) {
      it(`repository document: ${path}`, () => {
        // About 120 prefixes per document: a from-scratch parse of each is the cost here.
        const maxChunk = Math.max(8, Math.ceil((text.length / 120) * 2));
        const failure = firstDivergence(path, text, 7, maxChunk);
        if (failure) throw new Error(describeFailure(failure));
      });
    }

    it('has real documents in the corpus', () => {
      expect(repositoryDocuments.length).toBeGreaterThanOrEqual(8);
    });

    it('holds for 400 random documents built from markdown line fragments', () => {
      // MARKDOWN_FUZZ_DOCUMENTS raises the count for a long soak run.
      const documentCount = Number(process.env.MARKDOWN_FUZZ_DOCUMENTS ?? 400);
      for (let documentSeed = 1; documentSeed <= documentCount; documentSeed++) {
        const random = createSeededRandom(documentSeed * 7919);
        const lineCount = 3 + Math.floor(random() * 30);
        const lines = Array.from(
          { length: lineCount },
          () => LINE_FRAGMENTS[Math.floor(random() * LINE_FRAGMENTS.length)] ?? ''
        );
        const failure = firstDivergence(
          `random document ${documentSeed}`,
          lines.join('\n'),
          documentSeed,
          6
        );
        if (failure) throw new Error(describeFailure(failure));
      }
    });

    it('holds for a long mixed document at several chunk sizes', () => {
      const mixed = Object.values(CRAFTED_DOCUMENTS).join('\n');
      for (const seed of [21, 22, 23, 24, 25, 26, 27, 28]) {
        const failure = firstDivergence('all crafted documents', mixed, seed, 3 + seed);
        if (failure) throw new Error(describeFailure(failure));
      }
    });
  });

  describe('what it re-lexes', () => {
    it('lexes and renders only the tail block when a chunk extends the last paragraph', () => {
      const engine = new IncrementalMarkdown(newParser());
      const settled = Array.from({ length: 30 }, (_, index) => `paragraph ${index}`).join('\n\n');
      engine.blocks(`${settled}\n\nlive`);
      engine.blocks(`${settled}\n\nlive tail`);

      // Only the live paragraph: the 30 before it end in a blank line.
      expect(engine.lastStats).toEqual({
        mode: 'tail',
        lexedTokens: 1,
        renderedTokens: 1,
        fullReason: null,
      });
    });

    it('keeps the string identity of every settled block across chunks', () => {
      const engine = new IncrementalMarkdown(newParser());
      const text = 'one\n\ntwo\n\nthree\n\nfour\n\n';
      const before = engine.blocks(`${text}five`);
      const after = engine.blocks(`${text}five and more`);

      expect(after.length).toBe(before.length);
      const changed = after.filter((html, index) => html !== before[index]).length;
      expect(changed).toBe(1);
      expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
      after.slice(0, -1).forEach((html, index) => expect(html).toBe(before[index] as string));
    });

    it('returns the previous blocks untouched when the text did not change', () => {
      const engine = new IncrementalMarkdown(newParser());
      const first = engine.blocks('a\n\nb');
      const second = engine.blocks('a\n\nb');

      expect(second).toBe(first);
      expect(engine.lastStats?.mode).toBe('unchanged');
    });

    it('lexes the whole text again when a chunk adds a reference definition', () => {
      const engine = new IncrementalMarkdown(newParser());
      engine.blocks('See [docs] here.\n\nmiddle\n\n');
      const html = engine
        .blocks('See [docs] here.\n\nmiddle\n\n[docs]: https://docs.example\n')
        .join('');

      expect(engine.lastStats?.fullReason).toBe('new-reference-definition');
      expect(html).toContain('<a href="https://docs.example"');
    });

    it('lexes the whole text again when the text is not an extension of the last one', () => {
      const engine = new IncrementalMarkdown(newParser());
      engine.blocks('abc\n\ndef');
      engine.blocks('xyz\n\ndef');

      expect(engine.lastStats).toMatchObject({ mode: 'full', fullReason: 'not-an-extension' });
    });

    it('treats a carriage return that later becomes half of a CRLF as a rewrite, not an append', () => {
      const parser = newParser();
      const engine = new IncrementalMarkdown(parser);
      engine.blocks('a\r');
      const html = engine.blocks('a\r\nb\r\n\r\nc').join('');

      expect(html).toBe(parser.parse('a\r\nb\r\n\r\nc', { async: false }));
    });

    it('starts over for an empty text and for a text it never saw', () => {
      const engine = new IncrementalMarkdown(newParser());
      engine.blocks('abc');

      expect(engine.blocks('')).toEqual([]);
      expect(engine.blocks('def').join('')).toContain('def');
      expect(engine.lastStats?.mode).toBe('full');
    });

    it('renders a different parser over the same text with that parser, not the cache', () => {
      const text = '```ts\ncode\n```\n';
      const coloured = new IncrementalMarkdown(newParser()).blocks(text).join('');
      const plain = new IncrementalMarkdown(createParser('one-dark-pro', 'Copy', null))
        .blocks(text)
        .join('');

      expect(coloured).toContain('class="shiki"');
      expect(plain).not.toContain('class="shiki"');
    });
  });

  describe('stableBoundary', () => {
    /** The source offset the stable prefix of `source` ends at: where the tail would be lexed from. */
    function stableOffsetOf(source: string): number {
      const tokens = Lexer.lex(source, newParser().defaults);
      const ends: number[] = [];
      let offset = 0;
      for (const token of tokens) ends.push((offset += token.raw.length));
      const keep = stableBoundary(tokens, ends, source);
      return keep === 0 ? 0 : (ends[keep - 1] ?? 0);
    }

    it('ends the stable prefix at the last blank line after a closed block', () => {
      const source = 'first\n\nsecond\n\nthird still arriv';
      expect(source.slice(stableOffsetOf(source))).toBe('third still arriv');
    });

    it('is the whole text when it ends on a blank line after a paragraph', () => {
      const source = 'first\n\nsecond\n\n';
      expect(stableOffsetOf(source)).toBe(source.length);
    });

    it('keeps a list in the tail, because a later indented or numbered line continues it', () => {
      const source = 'intro\n\n1. a\n\n   b\n\n2';
      expect(source.slice(stableOffsetOf(source))).toBe('1. a\n\n   b\n\n2');
    });

    it('keeps an indented code block, an unclosed fence and an HTML block in the tail', () => {
      for (const open of [
        '    code\n\n',
        '```ts\nconst a = 1;\n\n',
        '<!-- note\n\n',
        '<div>\n\n',
      ]) {
        const source = `intro\n\n${open}`;
        expect(source.slice(stableOffsetOf(source))).toBe(open);
      }
    });

    it('lets a closed fence end the stable prefix', () => {
      const source = '```ts\nconst a = 1;\n```\n\nafter';
      expect(source.slice(stableOffsetOf(source))).toBe('after');
    });

    it('does not take a whitespace-only last line for a blank line', () => {
      const source = 'para\n\nnext\n  ';
      expect(source.slice(stableOffsetOf(source))).toBe('next\n  ');
    });

    it('is zero when no blank line has closed a block yet', () => {
      expect(stableOffsetOf('# heading\ntext\n- item')).toBe(0);
      expect(stableOffsetOf('')).toBe(0);
    });
  });

  describe('sanitization across chunk boundaries', () => {
    const attack = [
      'safe\n\n<img src=x onerror=alert(1)>\n\n',
      'text <img src=x onerror=alert(2)> inline\n\n',
      '[click](javascript:alert(3)) and [x<img src=y onerror=alert(4)>](https://ok.example)\n\n',
      '![pic](javascript:alert(5))\n\n[ref][r]\n\n[r]: javascript:alert(6)\n',
    ].join('');

    it('never emits a live tag, event handler or script URL, at any split point', () => {
      const parser = newParser();
      for (let split = 1; split < attack.length; split++) {
        const engine = new IncrementalMarkdown(parser);
        engine.blocks(attack.slice(0, split));
        const html = engine.blocks(attack).join('');
        const scratch = document.createElement('div');
        scratch.innerHTML = html;

        expect(scratch.querySelector('img')).toBeNull();
        expect(scratch.querySelector('script')).toBeNull();
        for (const element of scratch.querySelectorAll('*')) {
          for (const attribute of element.getAttributeNames()) {
            expect(attribute.startsWith('on')).toBe(false);
          }
        }
        for (const anchor of scratch.querySelectorAll('a')) {
          expect(anchor.getAttribute('href')?.toLowerCase().startsWith('javascript:')).toBe(false);
        }
        expect(html).toBe(parser.parse(attack, { async: false }));
      }
    });
  });
});

describe('BlockDomMirror', () => {
  function mirrorOf(): { mirror: BlockDomMirror; container: HTMLElement } {
    const container = document.createElement('div');
    return { mirror: new BlockDomMirror(container), container };
  }

  it('builds the same markup as setting innerHTML', () => {
    const { mirror, container } = mirrorOf();
    mirror.sync(['<p>a</p>\n', '', '<ul>\n<li>b</li>\n</ul>\n']);

    expect(container.innerHTML).toBe('<p>a</p>\n<ul>\n<li>b</li>\n</ul>\n');
  });

  it('leaves the nodes of unchanged blocks in place and replaces only the changed tail', () => {
    const { mirror, container } = mirrorOf();
    mirror.sync(['<p>one</p>\n', '<p>two</p>\n', '<p>thr</p>\n']);
    const [first, , second, , third] = [...container.childNodes];
    expect(container.children).toHaveLength(3);

    mirror.sync(['<p>one</p>\n', '<p>two</p>\n', '<p>three</p>\n', '<p>four</p>\n']);

    expect(container.children[0]).toBe(first as Element);
    expect(container.children[1]).toBe(second as Element);
    expect(container.children[2]).not.toBe(third as Element);
    expect(container.innerHTML).toBe('<p>one</p>\n<p>two</p>\n<p>three</p>\n<p>four</p>\n');
  });

  it('handles an insertion and a removal in the middle', () => {
    const { mirror, container } = mirrorOf();
    mirror.sync(['<p>a</p>', '<p>b</p>', '<p>c</p>']);
    mirror.sync(['<p>a</p>', '<p>x</p>', '<p>y</p>', '<p>b</p>', '<p>c</p>']);
    expect(container.innerHTML).toBe('<p>a</p><p>x</p><p>y</p><p>b</p><p>c</p>');

    mirror.sync(['<p>a</p>', '<p>c</p>']);
    expect(container.innerHTML).toBe('<p>a</p><p>c</p>');

    mirror.sync([]);
    expect(container.innerHTML).toBe('');
  });

  it('inserts before the next non-empty block when the changed block is followed by empty ones', () => {
    const { mirror, container } = mirrorOf();
    mirror.sync(['<p>a</p>', '', '<p>c</p>']);
    mirror.sync(['<p>a</p>', '<p>b</p>', '<p>c</p>']);

    expect(container.innerHTML).toBe('<p>a</p><p>b</p><p>c</p>');
  });

  it('matches a from-scratch render through a whole stream', () => {
    const parser = newParser();
    const engine = new IncrementalMarkdown(parser);
    const { mirror, container } = mirrorOf();
    const text = Object.values(CRAFTED_DOCUMENTS).join('\n');
    for (const end of chunkEnds(text.length, 40, createSeededRandom(5))) {
      mirror.sync(engine.blocks(text.slice(0, end)));
      const scratch = document.createElement('div');
      scratch.innerHTML = parser.parse(text.slice(0, end), { async: false });

      expect(container.innerHTML).toBe(scratch.innerHTML);
    }
  });
});

function readRepositoryDocuments(): { path: string; text: string }[] {
  const found: { path: string; text: string; size: number }[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.md')) {
        const text = readFileSync(full, 'utf8');
        found.push({ path: full.slice(REPOSITORY_DOCS.length + 1), text, size: text.length });
      }
    }
  };
  visit(REPOSITORY_DOCS);
  // A spread over the size range, up to 40 KB each so the suite stays quick.
  const sorted = found.filter((doc) => doc.size <= 40_000).sort((a, b) => a.size - b.size);
  const picked: typeof sorted = [];
  for (let index = 0; index < sorted.length; index += Math.max(1, Math.floor(sorted.length / 16))) {
    const document = sorted[index];
    if (document) picked.push(document);
  }
  return picked;
}
