/**
 * The status text colours clear 4.5:1 where they are actually read.
 *
 * `design-tokens-doc.test.ts` keeps the table's hex values in step with the
 * stylesheet, but a hex that is wrong in both places passes it. The mistake this
 * guards against is subtler than a bad colour: light `success` was 4.57:1 on the
 * canvas and fell to 4.0:1 once it sat on its own `success-subtle` wash — a
 * badge, an added diff line — so a token table checked against plain white
 * looked fine.
 */

import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

const STYLESHEET = join(import.meta.dir, '../../src/index.css');

type Rgb = readonly [number, number, number];

function parse(value: string): { rgb: Rgb; alpha: number } {
  const hex = value.replace('#', '');
  const channel = (index: number) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return {
    rgb: [channel(0), channel(1), channel(2)],
    alpha: hex.length === 8 ? channel(3) / 255 : 1,
  };
}

function over(foreground: string, background: Rgb): Rgb {
  const { rgb, alpha } = parse(foreground);
  return [0, 1, 2].map((i) => rgb[i] * alpha + background[i] * (1 - alpha)) as unknown as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((value) => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function tokens(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6,8});/gi)) {
    found.set(match[1], match[2]);
  }
  return found;
}

async function themes(): Promise<Record<'dark' | 'light', Map<string, string>>> {
  const css = (await Bun.file(STYLESHEET).text()).replace(/\/\*[\s\S]*?\*\//g, '');
  const darkStart = css.indexOf('@theme static');
  const lightStart = css.search(/\[data-theme=(['"])light\1\]\s*\{/);
  return {
    dark: tokens(css.slice(darkStart, css.indexOf('@keyframes blink', darkStart))),
    light: tokens(css.slice(lightStart, css.indexOf('@utility', lightStart))),
  };
}

const FLOOR = 4.5;
const SURFACES = ['canvas', 'sidebar', 'surface'] as const;

describe('status text contrast', () => {
  for (const status of ['success', 'warning'] as const) {
    for (const theme of ['dark', 'light'] as const) {
      it(`${theme} ${status} clears ${FLOOR}:1 on its own tint over every surface`, async () => {
        const palette = (await themes())[theme];
        const text = parse(palette.get(status) ?? '').rgb;
        const tint = palette.get(`${status}-subtle`) ?? '';

        const ratios = SURFACES.flatMap((surface) => {
          const base = parse(palette.get(surface) ?? '').rgb;
          return [
            { where: `${surface}`, ratio: contrast(text, base) },
            { where: `${surface} + ${status}-subtle`, ratio: contrast(text, over(tint, base)) },
          ];
        });

        const failing = ratios.filter(({ ratio }) => ratio < FLOOR);
        expect(failing.map(({ where, ratio }) => `${where}: ${ratio.toFixed(2)}`)).toEqual([]);
      });
    }
  }

  // Danger and info are held to the surfaces their badges and callouts sit on in
  // the main content; the sidebar carries neither.
  for (const status of ['danger', 'info'] as const) {
    for (const theme of ['dark', 'light'] as const) {
      it(`${theme} ${status} clears ${FLOOR}:1 on its own tint over canvas and surface`, async () => {
        const palette = (await themes())[theme];
        const text = parse(palette.get(status) ?? '').rgb;
        const tint = palette.get(`${status}-subtle`) ?? '';

        for (const surface of ['canvas', 'surface'] as const) {
          const base = parse(palette.get(surface) ?? '').rgb;
          expect(contrast(text, over(tint, base))).toBeGreaterThanOrEqual(FLOOR);
        }
      });
    }
  }
});

// Text laid over a picture. The veil cannot know what is under it, so the pair is
// checked against the worst picture there is — a pure-white pixel — and must be
// the same in both themes, because a photograph is not themed.
describe('text over media', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`${theme} on-scrim-media clears ${FLOOR}:1 over scrim-media on a white pixel`, async () => {
      const palette = (await themes())[theme];
      const veiled = over(palette.get('scrim-media') ?? '', [255, 255, 255]);

      expect(
        contrast(parse(palette.get('on-scrim-media') ?? '').rgb, veiled)
      ).toBeGreaterThanOrEqual(FLOOR);
    });
  }

  it('is the same pair in both themes', async () => {
    const { dark, light } = await themes();

    expect(light.get('scrim-media')).toBe(dark.get('scrim-media'));
    expect(light.get('on-scrim-media')).toBe(dark.get('on-scrim-media'));
  });
});
