/**
 * Source text with comments and the text of string and template literals replaced
 * by spaces, so a scan for a call pattern reports code and nothing else. Newlines
 * stay, and every other character keeps its offset, which keeps line numbers and
 * columns valid against the original.
 *
 * A `${ ... }` expression inside a template literal is code and survives. Regular
 * expression literals are not recognized: a `/'/` would open a string that runs to
 * the end of its line.
 *
 * @example
 * blankNonCode("// a\nmock.module('x')"); // "    \nmock.module(' ')"
 */
export function blankNonCode(source: string): string {
  const out = [...source];
  const blank = (from: number, to: number): void => {
    for (let index = from; index < Math.min(to, out.length); index += 1) {
      if (out[index] !== '\n') out[index] = ' ';
    }
  };
  // One entry per open `${`: the count of `{` still open inside that expression.
  const expressionBraces: number[] = [];
  let inTemplateText = false;
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (inTemplateText) {
      if (char === '\\') {
        blank(index, index + 2);
        index += 2;
      } else if (char === '`') {
        inTemplateText = false;
        index += 1;
      } else if (char === '$' && next === '{') {
        expressionBraces.push(0);
        inTemplateText = false;
        index += 2;
      } else {
        blank(index, index + 1);
        index += 1;
      }
      continue;
    }

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
    } else if (char === "'" || char === '"') {
      index = blankQuotedString(source, index, blank);
    } else if (char === '`') {
      inTemplateText = true;
      index += 1;
    } else if (char === '{' && expressionBraces.length > 0) {
      expressionBraces[expressionBraces.length - 1] += 1;
      index += 1;
    } else if (char === '}' && expressionBraces.length > 0) {
      if (expressionBraces[expressionBraces.length - 1] === 0) {
        expressionBraces.pop();
        inTemplateText = true;
      } else {
        expressionBraces[expressionBraces.length - 1] -= 1;
      }
      index += 1;
    } else {
      index += 1;
    }
  }

  return out.join('');
}

/** Blanks one `'...'` or `"..."` literal that opens at `open`; returns the index after it. */
function blankQuotedString(
  source: string,
  open: number,
  blank: (from: number, to: number) => void
): number {
  const quote = source[open];
  let index = open + 1;
  while (index < source.length && source[index] !== quote && source[index] !== '\n') {
    index += source[index] === '\\' ? 2 : 1;
  }
  blank(open + 1, index);
  return source[index] === quote ? index + 1 : index;
}
