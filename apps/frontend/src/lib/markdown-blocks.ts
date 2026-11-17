import { Lexer, type Marked, type MarkedOptions, type Token } from 'marked';

/** What one `IncrementalLexer.update()` call did, for the benchmark and for tests that pin the work. */
export interface MarkdownLexStats {
  /** How the call got its tokens: nothing new, the tail only, or the whole text. */
  readonly mode: 'unchanged' | 'tail' | 'full';
  /** Top-level tokens lexed by this call. */
  readonly lexedTokens: number;
  /** Why the whole text was lexed; null when it was not. */
  readonly fullReason: MarkdownFullReason | null;
}

export type MarkdownFullReason =
  | 'first-call'
  | 'not-an-extension'
  | 'new-reference-definition'
  | 'top-level-text'
  | 'raw-mismatch';

/** The top-level tokens of a text. Tokens that did not change between updates are the same objects. */
export interface MarkdownTokens {
  readonly tokens: readonly Token[];
  /**
   * False when the tokens cannot be rendered one by one (a top-level `text` token, which marked
   * merges with its neighbours, or raw text that does not add up to the source). They must then
   * be rendered together.
   */
  readonly splittable: boolean;
}

const LINE_BREAKS = /\r\n|\r/g;
const NO_TOKENS: MarkdownTokens = { tokens: [], splittable: true };

/**
 * Lexes a text that grows, lexing again only what a longer text can have changed.
 *
 * A streamed answer is a longer and longer prefix of itself. Lexing all of it on every chunk is
 * quadratic over the stream, so this keeps the tokens of the previous text and, for a text that
 * extends it, lexes again only from the last blank line that nothing can continue across (see
 * `stableBoundary`). Before it, a block is final: a later line cannot join a paragraph, table,
 * quote or heading a blank line has closed. Within the region after it nothing is assumed: a
 * half-typed line can change where an earlier block there ended (`**b\n2. two\n-` makes `2. two`
 * a setext candidate and cuts the paragraph above it).
 *
 * One thing reaches back past a blank line: a link reference definition turns `[x]` in any
 * earlier block into a link. A text whose tail changes the set of definitions is lexed from
 * scratch (`MarkdownFullReason`), as is anything that is not an append to the last text.
 *
 * `markdown-blocks.test.ts` streams a corpus in random chunks and asserts that the tokens,
 * rendered, equal what a from-scratch parse returns for every prefix.
 *
 * Usage: const lexer = new IncrementalLexer(options); const { tokens } = lexer.update(text);
 */
export class IncrementalLexer {
  readonly #options: MarkedOptions;
  #source = '';
  #tokens: Token[] = [];
  /** `#ends[i]` is the source offset where token `i` ends. */
  #ends: number[] = [];
  #definitions: Definitions = Object.create(null) as Definitions;
  #splittable = true;
  #lastStats: MarkdownLexStats | null = null;
  #lastResult: MarkdownTokens = NO_TOKENS;

  constructor(options: MarkedOptions) {
    this.#options = options;
  }

  /** What the most recent `update()` did; null before the first. */
  get lastStats(): MarkdownLexStats | null {
    return this.#lastStats;
  }

  update(content: string): MarkdownTokens {
    if (!content) {
      this.#reset();
      return this.#finish('unchanged', 0, null, NO_TOKENS);
    }
    const source = content.includes('\r') ? content.replace(LINE_BREAKS, '\n') : content;
    if (this.#source === '') return this.#lexAll(source, 'first-call');
    if (source === this.#source) return this.#finish('unchanged', 0, null, this.#lastResult);
    if (!this.#splittable) return this.#lexAll(source, 'top-level-text');
    // A carriage return at the end of a chunk is a line break now and half of a CRLF next
    // chunk, so the earlier text is no longer a prefix; neither is any edit that is not an append.
    if (!source.startsWith(this.#source)) return this.#lexAll(source, 'not-an-extension');
    return this.#lexTail(source);
  }

  #reset(): void {
    this.#source = '';
    this.#tokens = [];
    this.#ends = [];
    this.#definitions = Object.create(null) as Definitions;
    this.#splittable = true;
  }

  #lexTail(source: string): MarkdownTokens {
    const keep = stableBoundary(this.#tokens, this.#ends, this.#source);
    const keepEnd = keep === 0 ? 0 : (this.#ends[keep - 1] ?? 0);
    const lexer = new Lexer(this.#options);
    // Only the definitions in the kept blocks are known going in: one in the tail may be a
    // half-typed version of a definition the previous text had, and the first definition of a
    // label wins, so seeding it from the previous map would pin the stale one.
    if (Object.keys(this.#definitions).length > 0) {
      Object.assign(lexer.tokens.links, definitionsOf(this.#tokens.slice(0, keep)));
    }
    const tailTokens = lexer.lex(source.slice(keepEnd));

    // A block before the tail may have used a label the tail now defines, redefines or no
    // longer defines, and it is not lexed again: fall back to the whole text.
    if (!sameDefinitions(lexer.tokens.links as Definitions, this.#definitions)) {
      return this.#lexAll(source, 'new-reference-definition');
    }
    if (tailTokens.some((token) => token.type === 'text')) {
      return this.#lexAll(source, 'top-level-text');
    }
    const ends = this.#ends.slice(0, keep);
    let offset = keepEnd;
    for (const token of tailTokens) {
      offset += token.raw.length;
      ends.push(offset);
    }
    if (offset !== source.length) return this.#lexAll(source, 'raw-mismatch');

    this.#source = source;
    this.#tokens = [...this.#tokens.slice(0, keep), ...tailTokens];
    this.#ends = ends;
    return this.#finish('tail', tailTokens.length, null, {
      tokens: this.#tokens,
      splittable: true,
    });
  }

  #lexAll(source: string, reason: MarkdownFullReason): MarkdownTokens {
    const lexer = new Lexer(this.#options);
    const tokens = lexer.lex(source);
    const ends: number[] = [];
    let offset = 0;
    for (const token of tokens) {
      offset += token.raw.length;
      ends.push(offset);
    }
    const hasTopLevelText = tokens.some((token) => token.type === 'text');
    const splittable = offset === source.length && !hasTopLevelText;

    this.#source = source;
    this.#definitions = { ...(lexer.tokens.links as Definitions) };
    this.#splittable = splittable;
    // A text that cannot be split is never extended in place: nothing is kept for it.
    this.#tokens = splittable ? [...tokens] : [];
    this.#ends = splittable ? ends : [];
    const effectiveReason =
      splittable || reason === 'first-call' || reason === 'not-an-extension'
        ? reason
        : hasTopLevelText
          ? 'top-level-text'
          : 'raw-mismatch';
    return this.#finish('full', tokens.length, effectiveReason, {
      tokens: splittable ? this.#tokens : [...tokens],
      splittable,
    });
  }

  #finish(
    mode: MarkdownLexStats['mode'],
    lexedTokens: number,
    fullReason: MarkdownFullReason | null,
    result: MarkdownTokens
  ): MarkdownTokens {
    this.#lastStats = { mode, lexedTokens, fullReason };
    this.#lastResult = result;
    return result;
  }
}

/**
 * Renders the tokens of a growing text to one HTML string per top-level block, rendering only
 * the tokens that are not the same objects as last time. Pairs with `IncrementalLexer`, which
 * hands the unchanged prefix back as the same token objects.
 *
 * The concatenation of the blocks is byte-for-byte what `parser.parse(text)` returns. Tokens
 * that cannot be rendered one by one (`MarkdownTokens.splittable`) come out as a single block,
 * which is what a plain `parse` does.
 *
 * Usage: const renderer = new IncrementalBlockRenderer(parser); const html = renderer.render(tokens);
 */
export class IncrementalBlockRenderer {
  readonly #parser: Marked;
  #renderedTokens: readonly Token[] = [];
  #blocks: readonly string[] = [];
  #lastRenderedCount = 0;

  constructor(parser: Marked) {
    this.#parser = parser;
  }

  /** How many tokens the most recent `render()` call rendered to HTML. */
  get lastRenderedCount(): number {
    return this.#lastRenderedCount;
  }

  /** Blocks whose token is unchanged keep their string identity, so a caller can diff by identity. */
  render({ tokens, splittable }: MarkdownTokens): readonly string[] {
    if (!splittable) {
      // One block holding everything, rendered the way `parse` does; nothing carries over.
      this.#renderedTokens = [];
      this.#lastRenderedCount = tokens.length;
      this.#blocks =
        tokens.length === 0 ? [] : [this.#parser.parser([...tokens], this.#parser.defaults)];
      return this.#blocks;
    }
    let reused = 0;
    const comparable = Math.min(tokens.length, this.#renderedTokens.length);
    while (reused < comparable && tokens[reused] === this.#renderedTokens[reused]) reused++;
    if (reused === tokens.length && reused === this.#renderedTokens.length) {
      this.#lastRenderedCount = 0;
      return this.#blocks;
    }
    const rendered = tokens.slice(reused).map((token) =>
      // `Marked#parser` is the static parser: it renders with the options it is given, so the
      // instance's renderer has to be passed in, unlike `parse` which merges its defaults.
      this.#parser.parser([token], this.#parser.defaults)
    );
    this.#blocks = [...this.#blocks.slice(0, reused), ...rendered];
    this.#renderedTokens = tokens;
    this.#lastRenderedCount = rendered.length;
    return this.#blocks;
  }
}

/**
 * How many leading tokens a longer text cannot change: the ones up to the last blank line that
 * no block can continue across.
 *
 * A blank line closes a paragraph, heading, table, quote or rule, and the text after it starts
 * a block of its own, so none of those can be changed by what is typed later. Four blocks are
 * not closed by a blank line and so never end a stable prefix when they are the block the blank
 * line follows: a list (`1. a\n\n   b` continues it, and `2` turning into `2.` pulls a later
 * item in), an indented code block (`    a\n\n    b` is one block), a fence that was never
 * closed, and an HTML block (an unclosed comment or `<pre>` runs on, and a blank line ends only
 * some kinds). A whitespace-only last line is not a blank line yet: `  ` may become `  more`,
 * which continues a paragraph.
 *
 * Returns 0 when there is no such place, and the whole text is then the tail.
 */
export function stableBoundary(
  tokens: readonly Token[],
  ends: readonly number[],
  source: string
): number {
  for (let index = tokens.length - 1; index >= 0; index--) {
    if (!endsWithBlankLine(source, ends[index] ?? 0)) continue;
    let closed = index;
    while (closed >= 0 && tokens[closed]?.type === 'space') closed--;
    const blockBeforeBlankLine = closed >= 0 ? tokens[closed] : undefined;
    if (blockBeforeBlankLine === undefined || isClosedByBlankLine(blockBeforeBlankLine)) {
      return index + 1;
    }
  }
  return 0;
}

/** Whether `source` up to `end` ends with a complete blank line: a line break, then spaces or tabs, then another. */
function endsWithBlankLine(source: string, end: number): boolean {
  let at = end;
  if (source[at - 1] !== '\n') return false;
  at--;
  while (at > 0 && (source[at - 1] === ' ' || source[at - 1] === '\t')) at--;
  return at === 0 || source[at - 1] === '\n';
}

const FENCE_OPENING = /^ {0,3}(`{3,}|~{3,})/;

function isClosedByBlankLine(token: Token): boolean {
  switch (token.type) {
    case 'list':
    case 'html':
      return false;
    case 'code':
      return token.codeBlockStyle !== 'indented' && isFenceClosed(token.raw);
    default:
      return true;
  }
}

function isFenceClosed(raw: string): boolean {
  const lines = raw.trimEnd().split('\n');
  const opening = FENCE_OPENING.exec(lines[0] ?? '')?.[1];
  const last = lines.length > 1 ? lines.at(-1)?.trim() : undefined;
  return (
    opening !== undefined &&
    last !== undefined &&
    last.length >= opening.length &&
    last.split('').every((char) => char === opening[0])
  );
}

type Definitions = Record<string, { href?: string; title?: string } | undefined>;

/**
 * The link reference map the lexer builds from `def` tokens: the first definition of a label
 * wins. Definitions inside a quote or a list item count too: marked's nested lexing registers
 * them in the same map, and the walk is in document order so "first" means the same thing.
 */
export function definitionsOf(tokens: readonly Token[]): Definitions {
  const links: Definitions = Object.create(null) as Definitions;
  collectDefinitions(tokens, links);
  return links;
}

function collectDefinitions(tokens: readonly Token[], links: Definitions): void {
  for (const token of tokens) {
    if (token.type === 'def') {
      links[token.tag as string] ??= { href: token.href as string, title: token.title as string };
    } else if (token.type === 'blockquote') {
      collectDefinitions(token.tokens ?? [], links);
    } else if (token.type === 'list') {
      for (const item of token.items) collectDefinitions(item.tokens, links);
    }
  }
}

function sameDefinitions(left: Definitions, right: Definitions): boolean {
  const leftLabels = Object.keys(left);
  if (leftLabels.length !== Object.keys(right).length) return false;
  return leftLabels.every(
    (label) =>
      left[label]?.href === right[label]?.href && left[label]?.title === right[label]?.title
  );
}

/**
 * Keeps a container's children equal to the concatenated HTML of `blocks`, touching only the
 * range that changed. The container's nodes are the same ones `innerHTML = blocks.join('')`
 * would build, except that adjacent text nodes are not merged; selection, focus and any node
 * a user is working with in an untouched block survive a sync.
 *
 * Usage: const mirror = new BlockDomMirror(element); mirror.sync(renderer.render(tokens));
 */
export class BlockDomMirror {
  readonly container: HTMLElement;
  #blocks: readonly string[] = [];
  #nodes: Node[][] = [];

  constructor(container: HTMLElement) {
    this.container = container;
  }

  sync(next: readonly string[]): void {
    const previous = this.#blocks;
    const limit = Math.min(previous.length, next.length);
    let head = 0;
    while (head < limit && previous[head] === next[head]) head++;
    let tail = 0;
    while (
      tail < limit - head &&
      previous[previous.length - 1 - tail] === next[next.length - 1 - tail]
    ) {
      tail++;
    }
    if (head === previous.length && head === next.length) return;

    const removedEnd = previous.length - tail;
    const anchor = firstNodeAfter(this.#nodes, removedEnd);
    for (const nodes of this.#nodes.slice(head, removedEnd)) {
      for (const node of nodes) node.parentNode?.removeChild(node);
    }

    const scratch = this.container.ownerDocument.createElement(this.container.tagName);
    const inserted = next.slice(head, next.length - tail).map((html) => {
      scratch.innerHTML = html;
      const nodes = [...scratch.childNodes];
      for (const node of nodes) this.container.insertBefore(node, anchor);
      return nodes;
    });

    this.#nodes = [...this.#nodes.slice(0, head), ...inserted, ...this.#nodes.slice(removedEnd)];
    this.#blocks = next;
  }
}

function firstNodeAfter(nodes: readonly (readonly Node[])[], index: number): Node | null {
  for (let at = index; at < nodes.length; at++) {
    const first = nodes[at]?.[0];
    if (first) return first;
  }
  return null;
}
