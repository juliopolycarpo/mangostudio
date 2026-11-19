/**
 * A deliberately small Starlark tokenizer for Codex `.rules` files.
 *
 * Codex evaluates those files as Starlark, so a rule is a call that may span any
 * number of lines. This reads only as much of the language as the rule
 * declarations need: comments, quoted strings (single, double, triple-quoted,
 * raw), identifiers, numbers, and bracket structure. Newlines inside brackets
 * are insignificant, as in Starlark, so the tokens carry a `newline` marker only
 * where a statement can end.
 *
 * It is tolerant in what it accepts as a token and strict about structure: an
 * unterminated string or unbalanced bracket throws `RulesSyntaxError`, because
 * guessing where such a statement ends would report a rule that is not there.
 */

export type RulesToken =
  | { readonly kind: 'string'; readonly value: string; readonly line: number }
  | { readonly kind: 'word'; readonly value: string; readonly line: number }
  | { readonly kind: 'punct'; readonly value: string; readonly line: number }
  | { readonly kind: 'newline'; readonly line: number };

export class RulesSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'RulesSyntaxError';
  }
}

const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set(Object.values(OPENERS));
const WORD_CHAR = /[A-Za-z0-9_.]/;
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  '\\': '\\',
  '"': '"',
  "'": "'",
};

export function tokenizeRules(source: string): RulesToken[] {
  const tokens: RulesToken[] = [];
  const open: { readonly closer: string; readonly line: number }[] = [];
  let index = 0;
  let line = 1;

  while (index < source.length) {
    const char = source[index] as string;

    if (char === '\n') {
      // Statement boundary only outside brackets.
      if (open.length === 0) tokens.push({ kind: 'newline', line });
      line += 1;
      index += 1;
    } else if (char === ' ' || char === '\t' || char === '\r') {
      index += 1;
    } else if (
      char === '\\' &&
      (source[index + 1] === '\n' || source.startsWith('\r\n', index + 1))
    ) {
      // Explicit line continuation joins the next line to this statement.
      index += source[index + 1] === '\r' ? 3 : 2;
      line += 1;
    } else if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
    } else if (char === '"' || char === "'") {
      const read = readString(source, index, line, false);
      tokens.push({ kind: 'string', value: read.value, line });
      index = read.end;
      line += read.newlines;
    } else if (WORD_CHAR.test(char)) {
      let end = index;
      while (end < source.length && WORD_CHAR.test(source[end] as string)) end += 1;
      const word = source.slice(index, end);
      const quote = source[end];
      // `r"..."` is a raw string; its prefix is not a word of its own.
      if (/^[rR]$/.test(word) && (quote === '"' || quote === "'")) {
        const read = readString(source, end, line, true);
        tokens.push({ kind: 'string', value: read.value, line });
        index = read.end;
        line += read.newlines;
      } else {
        tokens.push({ kind: 'word', value: word, line });
        index = end;
      }
    } else {
      if (char in OPENERS) {
        open.push({ closer: OPENERS[char] as string, line });
      } else if (CLOSERS.has(char)) {
        const expected = open.pop();
        if (expected?.closer !== char) {
          throw new RulesSyntaxError(`unexpected '${char}'`, line);
        }
      }
      tokens.push({ kind: 'punct', value: char, line });
      index += 1;
    }
  }

  const unclosed = open.at(-1);
  if (unclosed)
    throw new RulesSyntaxError(`'${unclosed.closer}' expected to close a bracket`, unclosed.line);
  return tokens;
}

interface StringRead {
  readonly value: string;
  readonly end: number;
  readonly newlines: number;
}

function readString(source: string, start: number, line: number, raw: boolean): StringRead {
  const quote = source[start] as string;
  const triple = source.startsWith(quote.repeat(3), start);
  const delimiter = triple ? quote.repeat(3) : quote;
  let index = start + delimiter.length;
  let value = '';
  let newlines = 0;

  while (index < source.length) {
    if (source.startsWith(delimiter, index)) {
      return { value, end: index + delimiter.length, newlines };
    }
    const char = source[index] as string;
    if (char === '\n') {
      // A single-quoted string cannot cross a line; a triple-quoted one can.
      if (!triple) break;
      newlines += 1;
    }
    if (char === '\\' && index + 1 < source.length) {
      const next = source[index + 1] as string;
      if (next === '\n') newlines += 1;
      if (raw) {
        value += char + next;
      } else if (next !== '\n') {
        // An escaped newline joins the lines and contributes no character.
        value += SIMPLE_ESCAPES[next] ?? char + next;
      }
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }
  throw new RulesSyntaxError('unterminated string', line);
}
