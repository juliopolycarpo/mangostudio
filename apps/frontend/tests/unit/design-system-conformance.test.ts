/**
 * The flat design system, enforced as text.
 *
 * `docs/design/` is the contract; this is what keeps it a contract. Tailwind
 * cannot tell a class that belongs to the system from one that is simply
 * absent, and that is the dangerous half: the theme in `index.css` empties the
 * radius, shadow and type scales it replaces, so `rounded-2xl` or `text-lg`
 * compiles to *nothing* and the element silently loses its radius or size —
 * past `check`, past every component test, and into a screenshot nobody takes.
 * The same goes for the Material-era colour names this migration retired.
 *
 * So the scan reads every source file as text and fails with `file:line` for
 * anything outside the vocabulary. To keep a deliberate exception, add it to
 * {@link ALLOWED} with the reason — an exception that cannot say why is a bug.
 */

import { describe, expect, it } from 'bun:test';
import { join, relative } from 'node:path';
import { Glob } from 'bun';

const SRC = join(import.meta.dir, '../../src');

interface Rule {
  /** What the rule protects, quoted back in the failure message. */
  readonly why: string;
  readonly pattern: RegExp;
  /** Comments describing a retired token are stale documentation, so some rules read them too. */
  readonly includeComments?: boolean;
  /** Class strings live in TypeScript; a stylesheet may use the property the rule bans. */
  readonly sourceOnly?: boolean;
}

/** A class token, with its variants, as Tailwind would scan it. */
const VARIANTS = String.raw`(?:[\w\[\]=&>*\-.()]+:)*`;
const COLOR_UTILS = `(?:bg|text|border(?:-[trblxy])?|ring|divide|outline|fill|stroke|from|via|to|shadow|decoration|accent|caret|placeholder)`;
const SEMANTIC_COLORS = `(?:fg|fg-muted|fg-subtle|stroke|stroke-strong|canvas|sidebar|surface|surface-raised|control|control-hover|control-pressed|fill-hover|fill-pressed|fill-selected|accent|accent-hover|accent-pressed|accent-fg|accent-subtle|on-accent|focus|success|success-subtle|warning|warning-subtle|danger|danger-subtle|danger-solid|on-danger|info|info-subtle|scrim|agent-[a-z]+)`;
const edge = (body: string) =>
  new RegExp(String.raw`(?<![\w\-/])${VARIANTS}${body}(?![\w\-])`, 'g');

const RULES: readonly Rule[] = [
  {
    why: 'Material-era colour vocabulary was retired — use the tokens in docs/design/foundations.md',
    includeComments: true,
    pattern: new RegExp(
      [
        `surface-container`,
        String.raw`\bon-surface\b`,
        String.raw`\bon-primary\b`,
        String.raw`\bon-background\b`,
        `outline-variant`,
        `primary-container`,
        `accent-muted`,
        `surface-dim`,
        `--color-(?:primary|error|tertiary|background|outline|on-(?:surface|primary|background|error)|surface-c)`,
        String.raw`\b${COLOR_UTILS}-(?:primary|error|tertiary|background|outline)(?![\w\-])`,
      ].join('|'),
      'g'
    ),
  },
  {
    why: 'glass and gradients are not part of the flat system — use surface-raised + stroke, or a solid fill',
    includeComments: true,
    pattern:
      /glass-(?:panel|elevated|bg|border|ring|shadow)|--glass-|backdrop-blur|backdrop-filter|\b(?:bg|from|via|to)-gradient|(?:linear|radial|conic)-gradient|--gradient-/g,
  },
  {
    why: 'one interface family: Manrope and the headline/body/label font roles were retired',
    includeComments: true,
    pattern: /\bfont-(?:headline|body|label)\b|--font-(?:headline|body|label)\b|manrope/gi,
  },
  {
    why: 'radii are xs/sm/md/lg (4/6/8/12) plus rounded-full for status — larger names compile to nothing',
    pattern: edge(
      String.raw`rounded(?:-(?:[trbl]|tl|tr|bl|br|s|e|ss|se|es|ee))?(?:-(?:xl|2xl|3xl|4xl)|(?=["'\`\s}]))`
    ),
  },
  {
    why: 'shadows exist only as shadow-popover and shadow-dialog (floating surfaces)',
    pattern: edge(
      String.raw`(?:shadow(?:-(?:sm|md|lg|xl|2xl|inner|xs))?(?=["'\`\s}])|drop-shadow(?:-\w+)?)`
    ),
  },
  {
    why: 'type scale is text-micro/xs/sm/base/title/headline — other sizes compile to nothing',
    pattern: edge(String.raw`text-(?:lg|xl|2xl|3xl|4xl|5xl|6xl|\[\d+(?:\.\d+)?(?:px|rem|em)\])`),
  },
  {
    why: 'weights are 400/500/600 — use font-medium or font-semibold',
    pattern: edge(`font-(?:bold|extrabold|black|thin|extralight|light)`),
  },
  {
    why: 'upper-case and letter-spacing belong to .micro-label only; badges and buttons are sentence case',
    sourceOnly: true,
    pattern: edge(`(?:uppercase|tracking-(?:wide|wider|widest))`),
  },
  {
    why: 'tints are tokens (*-subtle, fill-*), not opacity modifiers — a second /NN in one rule also downlevels badly',
    pattern: edge(String.raw`${COLOR_UTILS}-${SEMANTIC_COLORS}/\d+`),
  },
  {
    why: 'raw palette colours do not follow the theme — use a token from foundations.md',
    pattern: edge(
      String.raw`${COLOR_UTILS}-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:/\d+)?`
    ),
  },
  {
    why: 'scrims are bg-scrim; a raw black or white overlay does not follow the theme',
    pattern: edge(String.raw`(?:bg|border|text|ring|from|via|to)-(?:black|white)(?:/\d+)?`),
  },
  {
    why: 'hover and press change colour only — no scale, no transition-all',
    pattern: edge(
      String.raw`(?:(?:hover|active|group-hover|focus):)?(?:scale-[\w.\[\]]+)|transition-all`
    ),
  },
  {
    why: 'spacing steps are 0.5/1/1.5/2/3/4/5/6/8/12 — 10px and 14px paddings, gaps and margins are off the grid',
    pattern: edge(
      String.raw`-?(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-(?:2\.5|3\.5)`
    ),
  },
];

/** `file` (relative to src) → rules it may break, each with the reason. */
const ALLOWED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'components/ui/ToolAvatar.tsx': {
    'type scale is text-micro/xs/sm/base/title/headline — other sizes compile to nothing':
      'monogram sizes inside 16–24px avatar tiles: a glyph drawn in the tile, not running text',
    'upper-case and letter-spacing belong to .micro-label only; badges and buttons are sentence case':
      'a monogram is a glyph in a tile; the contract fixes it at two characters and the tile upper-cases them',
  },
  'components/ui/ContextRing.tsx': {
    'type scale is text-micro/xs/sm/base/title/headline — other sizes compile to nothing':
      'the percentage drawn inside a 16–20px ring is a data glyph, not running text',
  },
};

function stripComments(source: string, file: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  let out = source.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (!file.endsWith('.css'))
    out = out.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p: string) => p + blank(m.slice(p.length)));
  return out;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

async function violations(): Promise<string[]> {
  const found: string[] = [];
  const glob = new Glob('**/*.{ts,tsx,css}');
  for (const file of glob.scanSync({ cwd: SRC, absolute: false })) {
    if (file.endsWith('routeTree.gen.ts')) continue;
    const raw = await Bun.file(join(SRC, file)).text();
    const code = stripComments(raw, file);
    for (const rule of RULES) {
      if (ALLOWED[file]?.[rule.why]) continue;
      if (rule.sourceOnly && file.endsWith('.css')) continue;
      const text = rule.includeComments ? raw : code;
      for (const match of text.matchAll(rule.pattern)) {
        const hit = match[0].trim();
        if (!hit) continue;
        found.push(
          `${relative(SRC, join(SRC, file))}:${lineOf(text, match.index ?? 0)}  ${hit}   ← ${rule.why}`
        );
      }
    }
  }
  return found.sort();
}

describe('design system conformance', () => {
  it('keeps every source file inside the flat design vocabulary', async () => {
    const found = await violations();
    // A bare `toEqual([])` prints a wall of JSON; the joined list is what a
    // person fixing it actually wants to read.
    expect(found.join('\n')).toBe('');
  });

  it('does not allow an exception for a file that no longer exists', async () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(await Bun.file(join(SRC, file)).exists()).toBe(true);
    }
  });
});
