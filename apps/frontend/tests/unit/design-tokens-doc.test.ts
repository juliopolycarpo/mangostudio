/**
 * `docs/design/foundations.md` documents every colour token — and only the ones
 * that exist.
 *
 * The table is what a native port reads to map roles to platform resources, so
 * a token missing from it is a role nobody maps, and a token left in it after
 * its removal is a role someone maps to nothing. The values are compared too:
 * a hex that drifted between the stylesheet and the doc is the quiet version of
 * the same bug.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../../..');
const STYLESHEET = join(ROOT, 'apps/frontend/src/index.css');
const FOUNDATIONS = join(ROOT, 'docs/design/foundations.md');

/** `--color-<name>: <value>` declarations inside one block of the stylesheet. */
function colorTokens(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/--color-([a-z-]+):\s*([^;]+);/g)) {
    tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

async function themes() {
  const css = (await Bun.file(STYLESHEET).text()).replace(/\/\*[\s\S]*?\*\//g, '');
  const darkStart = css.indexOf('@theme static');
  const lightStart = css.search(/\[data-theme=(['"])light\1\]\s*\{/);
  const lightEnd = css.indexOf('@utility', lightStart);
  return {
    dark: colorTokens(css.slice(darkStart, css.indexOf('@keyframes blink', darkStart))),
    light: colorTokens(css.slice(lightStart, lightEnd)),
  };
}

/** `name → [dark, light]` from the markdown colour tables. */
async function documented(): Promise<Map<string, [string, string]>> {
  const rows = new Map<string, [string, string]>();
  const text = await Bun.file(FOUNDATIONS).text();
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim().replace(/^`|`$/g, ''));
    // | Token | Utility | Dark | Light | Use |
    if (
      cells.length >= 6 &&
      /^#[0-9a-f]{6,8}$/i.test(cells[3]) &&
      /^#[0-9a-f]{6,8}$/i.test(cells[4])
    ) {
      rows.set(cells[1], [cells[3], cells[4]]);
    }
  }
  return rows;
}

describe('docs/design/foundations.md colour table', () => {
  it('lists exactly the tokens the stylesheet defines, with the same values', async () => {
    const { dark, light } = await themes();
    const doc = await documented();

    expect([...doc.keys()].sort()).toEqual([...dark.keys()].sort());
    for (const [name, value] of dark) {
      expect(doc.get(name)?.[0]).toBe(value);
      expect(doc.get(name)?.[1]).toBe(light.get(name));
    }
  });

  it('gives the light theme a value for every token', async () => {
    const { dark, light } = await themes();

    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
  });
});
