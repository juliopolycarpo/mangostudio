/**
 * What the unlayered part of the stylesheets is allowed to touch.
 *
 * Tailwind's utilities live in `@layer utilities`, and a rule outside every
 * layer outranks a layered one whatever its specificity. A bare `img { height:
 * auto }` therefore silently beat `size-full` on every `<img>` in the app: the
 * gallery tiles, the chat's reserved image box and the tool avatars all drew
 * their picture at its natural height, top-aligned, with an empty block below.
 * Nothing failed — check, test and build were green — so the guard is here.
 *
 * The one deliberate exception is the coarse-pointer touch floor, which is
 * unlayered so a utility cannot undo it. Its price is the exemption list pinned
 * below.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

const STYLESHEETS = [
  join(import.meta.dir, '../../src/index.css'),
  join(import.meta.dir, '../../src/styles/markdown-content.css'),
];

/** Elements a utility such as `size-full` sizes, and a bare tag rule would fight. */
const REPLACED = new Set(['img', 'video', 'picture', 'svg', 'canvas', 'iframe', 'object']);

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The text of the `{ … }` block that opens at `open`, and the index after it. */
function block(css: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return { body: css.slice(open + 1, i), end: i + 1 };
  }
  return { body: css.slice(open + 1), end: css.length };
}

interface UnlayeredRule {
  readonly selector: string;
  /** The `@media` / `@supports` preludes it sits in. */
  readonly within: readonly string[];
}

/** Style rules outside every `@layer`, `@theme`, `@keyframes` and the like. */
function unlayeredRules(source: string, within: readonly string[] = []): UnlayeredRule[] {
  const rules: UnlayeredRule[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{', i);
    const semicolon = source.indexOf(';', i);
    if (open === -1) break;
    // A statement such as `@import "…";` or `@source …;` has no block.
    if (semicolon !== -1 && semicolon < open) {
      i = semicolon + 1;
      continue;
    }
    const prelude = source.slice(i, open).trim();
    const { body, end } = block(source, open);
    if (/^@(media|supports)\b/.test(prelude)) {
      rules.push(...unlayeredRules(body, [...within, prelude]));
    } else if (!prelude.startsWith('@')) {
      for (const selector of splitSelectors(prelude)) rules.push({ selector, within });
    }
    i = end;
  }
  return rules;
}

/** Splits on the commas outside parentheses and brackets. */
function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** The tag a selector's last compound starts with, when it starts with one. */
function subjectTag(selector: string): string | null {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];
    if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (depth === 0 && /[\s>+~]/.test(char)) start = i + 1;
  }
  return (
    selector
      .slice(start)
      .match(/^[a-z][a-z0-9-]*/i)?.[0]
      .toLowerCase() ?? null
  );
}

async function rulesOf(path: string): Promise<UnlayeredRule[]> {
  return unlayeredRules(withoutComments(await Bun.file(path).text()));
}

describe('unlayered rules', () => {
  it('never style a replaced element by its bare tag', async () => {
    const offenders: string[] = [];
    for (const path of STYLESHEETS) {
      for (const rule of await rulesOf(path)) {
        const tag = subjectTag(rule.selector);
        if (tag && REPLACED.has(tag)) offenders.push(`${path.split('/src/')[1]}: ${rule.selector}`);
      }
    }
    // Tailwind's preflight already sets `img { max-width: 100%; height: auto }`
    // in the base layer, where a utility beats it. Anything extra belongs in
    // `@layer base`, or on a class.
    expect(offenders).toEqual([]);
  });

  it('recognises the shapes it guards, so a passing run means something', () => {
    const css = '@layer base { img { height: auto } } @media (pointer: coarse) { img, a { x: y } }';
    expect(unlayeredRules(css).map((rule) => rule.selector)).toEqual(['img', 'a']);
    expect(subjectTag('.card > img:hover')).toBe('img');
    expect(subjectTag('.card .thumb')).toBeNull();
    expect(subjectTag('a:not(.markdown-content a)')).toBe('a');
  });
});

describe('the coarse-pointer touch floor', () => {
  async function floor(): Promise<UnlayeredRule[]> {
    const rules = (await rulesOf(STYLESHEETS[0])).filter((rule) =>
      rule.within.some((prelude) => /pointer:\s*coarse/.test(prelude))
    );
    expect(rules.length).toBeGreaterThan(0);
    return rules;
  }

  it('leaves checkbox, radio and range inputs to their own geometry', async () => {
    const inputs = (await floor()).filter((rule) => subjectTag(rule.selector) === 'input');
    expect(inputs.length).toBeGreaterThan(0);
    for (const { selector } of inputs) {
      for (const type of ['checkbox', 'radio', 'range']) {
        expect(selector).toMatch(new RegExp(`\\[type=(['"])${type}\\1\\]`));
      }
    }
  });

  it('leaves the 28px copy button over a code block alone', async () => {
    const buttons = (await floor()).filter((rule) => subjectTag(rule.selector) === 'button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const { selector } of buttons) expect(selector).toContain(':not(.copy-code-btn)');
  });

  it('leaves links inside markdown prose alone', async () => {
    const links = (await floor()).filter((rule) => subjectTag(rule.selector) === 'a');
    expect(links.length).toBeGreaterThan(0);
    for (const { selector } of links) expect(selector).toContain('.markdown-content a');
  });

  /**
   * A timeline node hangs half a row below its item's padding. The floor makes a
   * disclosable step 44px tall on touch, so the row height the node is hung
   * from has to follow it there, or every dot sits ~10px above its label.
   */
  it('raises the timeline row height to the floor it sets', async () => {
    const css = withoutComments(await Bun.file(STYLESHEETS[0]).text());
    const floorHeight = css.match(
      /@media \(pointer: coarse\)\s*\{[^@]*?button[^{]*\{[^}]*min-height:\s*(\d+)px/
    )?.[1];
    const rowHeight = css.match(
      /@media \(pointer: coarse\)\s*\{\s*\.chat-timeline\s*\{[^}]*--timeline-row-height:\s*([\d.]+)rem/
    )?.[1];

    expect(floorHeight).toBeDefined();
    expect(rowHeight).toBeDefined();
    expect(Number(rowHeight) * 16).toBe(Number(floorHeight));
  });
});
