/**
 * `color-mix()` written in `index.css` must still be `color-mix()` after the
 * bundler has had it.
 *
 * Tailwind's CSS pipeline downlevels `color-mix()` for browsers that lack it:
 * it rewrites the declaration to an opaque fallback and re-states the real one
 * inside `@supports (color: color-mix(in lab, red, red))`. It re-emits **only
 * the first** mixed declaration of each rule, so a second mix in the same rule
 * silently ships at full opacity.
 *
 * That is invisible to `check`, to `test`, and to the build — it cost a
 * status-line hairline that rendered as a solid bar and a pressed chip that
 * rendered as a solid block with same-coloured text on it. The fix is one mix
 * per rule; this is what notices when someone tidies two of them back together.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import tailwind from 'bun-plugin-tailwind';

const STYLESHEET = join(import.meta.dir, '../../src/index.css');

/** Every `color-mix(…)` expression in a stylesheet, parens balanced. */
function colorMixExpressions(css: string): string[] {
  const found: string[] = [];
  for (
    let index = css.indexOf('color-mix(');
    index !== -1;
    index = css.indexOf('color-mix(', index + 1)
  ) {
    let depth = 0;
    for (let cursor = index + 'color-mix'.length; cursor < css.length; cursor++) {
      if (css[cursor] === '(') depth++;
      else if (css[cursor] === ')') {
        depth--;
        if (depth === 0) {
          found.push(css.slice(index, cursor + 1));
          break;
        }
      }
    }
  }
  return found;
}

/** Whitespace is the only thing the minifier is allowed to change here. */
function squash(value: string): string {
  return value.replace(/\s+/g, '');
}

describe('color-mix survives the bundler', () => {
  it('keeps every mix authored in index.css', async () => {
    // Comments first: this file explains the trap in prose that names the
    // function, and a comment is not a declaration.
    const source = (await Bun.file(STYLESHEET).text()).replace(/\/\*[\s\S]*?\*\//g, '');
    const authored = colorMixExpressions(source);
    // A stylesheet that stopped using color-mix would make this test pass by
    // vacuum, so hold it to the fact that it does.
    expect(authored.length).toBeGreaterThan(5);

    const built = await Bun.build({
      entrypoints: [STYLESHEET],
      plugins: [tailwind],
      // The font files are served from the public dir, not bundled — the real
      // build marks them external for the same reason.
      external: ['/fonts/*'],
      throw: true,
    });
    const output = squash(await built.outputs[0].text());

    const dropped = authored.filter((expression) => !output.includes(squash(expression)));
    expect(dropped).toEqual([]);
  });
});
