/**
 * Terminal palette contrast.
 *
 * The palette lives as literal TS (see `terminal-theme.ts`'s module comment for
 * why) and is handed to xterm directly, so these contrast ratios are checked
 * against the exact numbers a screen paints.
 */

import { describe, expect, it } from 'bun:test';
import {
  buildTerminalTheme,
  fontSizePx,
  TERMINAL_PALETTES,
  type TerminalAnsiPalette,
} from '../../../../src/features/terminal/terminal-theme';

/** WCAG 2.1 AA for normal-size text. */
const DEFAULT_FG_BG_CONTRAST = 4.5;
/** The bar this brief sets for individual ANSI colours against the background. */
const ANSI_CONTRAST = 3;

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const rgb = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channelLuminance((rgb >> 16) & 255) +
    0.7152 * channelLuminance((rgb >> 8) & 255) +
    0.0722 * channelLuminance(rgb & 255)
  );
}

function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('terminal palette contrast', () => {
  for (const [appTheme, palette] of Object.entries(TERMINAL_PALETTES)) {
    it(`clears WCAG AA for the default foreground/background in ${appTheme}`, () => {
      expect(contrastRatio(palette.foreground, palette.background)).toBeGreaterThanOrEqual(
        DEFAULT_FG_BG_CONTRAST
      );
    });

    it(`clears 3:1 for every ANSI colour against the background in ${appTheme}`, () => {
      for (const [name, hex] of Object.entries(palette.ansi) as Array<
        [keyof TerminalAnsiPalette, string]
      >) {
        expect(
          contrastRatio(hex, palette.background),
          `${appTheme}.${name}`
        ).toBeGreaterThanOrEqual(ANSI_CONTRAST);
      }
    });
  }
});

describe('buildTerminalTheme', () => {
  it('maps the dark palette onto xterm ITheme fields', () => {
    const theme = buildTerminalTheme('dark');

    expect(theme.background).toBe(TERMINAL_PALETTES.dark.background);
    expect(theme.foreground).toBe(TERMINAL_PALETTES.dark.foreground);
    expect(theme.cursor).toBe(TERMINAL_PALETTES.dark.cursor);
    expect(theme.black).toBe(TERMINAL_PALETTES.dark.ansi.black);
    expect(theme.brightWhite).toBe(TERMINAL_PALETTES.dark.ansi.brightWhite);
  });

  it('maps the light palette onto xterm ITheme fields', () => {
    const theme = buildTerminalTheme('light');

    expect(theme.background).toBe(TERMINAL_PALETTES.light.background);
    expect(theme.red).toBe(TERMINAL_PALETTES.light.ansi.red);
  });
});

describe('fontSizePx', () => {
  it('matches the pixel sizes --chat-font-size uses per setting', () => {
    expect(fontSizePx('small')).toBe(13);
    expect(fontSizePx('default')).toBe(14);
    expect(fontSizePx('large')).toBe(16);
  });
});
