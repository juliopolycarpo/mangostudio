/**
 * The stylesheets author no `color-mix()`.
 *
 * Tailwind's CSS pipeline downlevels `color-mix()` for browsers that lack it:
 * it rewrites the declaration to an opaque fallback and re-states the real one
 * inside `@supports (color: color-mix(in lab, red, red))`. It re-emits **only
 * the first** mixed declaration of each rule, so a second mix in the same rule
 * silently ships at full opacity.
 *
 * That is invisible to `check`, to `test`, and to the build — it cost a
 * status-line hairline that rendered as a solid bar and a pressed chip that
 * rendered as a solid block with same-coloured text on it. The flat design
 * system has no use for the function: every tint it needs is a token (`*-subtle`,
 * `fill-*`), so the cheapest way to be safe is not to write one. If a stylesheet
 * ever needs a derived colour, add a token for it in `index.css` and
 * `docs/design/foundations.md` instead.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import tailwind from 'bun-plugin-tailwind';

const STYLESHEET = join(import.meta.dir, '../../src/index.css');
const STYLESHEETS = [STYLESHEET, join(import.meta.dir, '../../src/styles/markdown-content.css')];

/** Comments first: they may explain the trap in prose that names the function. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('stylesheets stay free of color-mix', () => {
  it('authors no color-mix() — tints are tokens', async () => {
    for (const path of STYLESHEETS) {
      const source = withoutComments(await Bun.file(path).text());
      expect({ path, mixes: source.match(/color-mix\(/g)?.length ?? 0 }).toEqual({
        path,
        mixes: 0,
      });
    }
  });

  it('still compiles through the bundler with the theme intact', async () => {
    const built = await Bun.build({
      entrypoints: [STYLESHEET],
      plugins: [tailwind],
      // The font files are served from the public dir, not bundled — the real
      // build marks them external for the same reason.
      external: ['/fonts/*'],
      throw: true,
    });
    const output = await built.outputs[0].text();

    // The tokens a native port maps, in both themes.
    expect(output).toContain('--color-canvas');
    expect(output).toContain('--color-accent-fg');
    expect(output).toMatch(/\[data-theme="?light"?\]/);
    // The two custom elevation utilities, which the conformance test relies on existing.
    expect(output).toContain('--elevation-popover');
    expect(output).toContain('--elevation-dialog');
  });
});

/**
 * The timeline's node offset is `calc(var(--timeline-*-gap) + …)`, and `calc()`
 * refuses to add a unitless number to a length. A gap written as plain `0`
 * therefore makes the whole `top` invalid, the dot falls to its static
 * position, and every node sits half a row below the row it belongs to.
 *
 * That reproduced only under the compact density, so no default-density
 * screenshot could catch it.
 */
describe('timeline density tokens', () => {
  it('gives every gap a unit, including zero', async () => {
    const source = (await Bun.file(STYLESHEET).text()).replace(/\/\*[\s\S]*?\*\//g, '');
    const declarations = Array.from(
      source.matchAll(/--timeline-(?:row|block)-gap:\s*([^;]+);/g),
      (match) => match[1].trim()
    );
    expect(declarations.length).toBeGreaterThan(3);

    const unitless = declarations.filter((value) => !/^-?[\d.]+(?:px|rem|em)$/.test(value));
    expect(unitless).toEqual([]);
  });
});
