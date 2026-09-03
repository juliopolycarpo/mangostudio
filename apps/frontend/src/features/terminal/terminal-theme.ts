import type { ITheme } from '@xterm/xterm';

/**
 * Terminal palette: the app's surface/on-surface tokens for the base colours,
 * plus a 16-colour ANSI set per app theme.
 *
 * Values are literal, not read from `index.css`'s custom properties, on the
 * same reasoning as `tool-avatar-palette.ts`: a contrast test has to check the
 * numbers a screen actually paints, and a CSS variable indirection would leave
 * it checking nothing. This module is the only source; xterm is handed these
 * objects directly. If a CSS consumer ever needs them, generate the custom
 * properties from `TERMINAL_PALETTES` rather than hand-mirroring the hexes.
 *
 * The "black"/"white" pair breaks the usual "bright is lighter" rule for the
 * light theme's chromatic colours (red, green, yellow, blue, magenta, cyan):
 * their bright variants are deliberately *darker*; on a white terminal
 * background a lighter red is a less visible red, not a bolder one.
 */
export interface TerminalAnsiPalette {
  readonly black: string;
  readonly red: string;
  readonly green: string;
  readonly yellow: string;
  readonly blue: string;
  readonly magenta: string;
  readonly cyan: string;
  readonly white: string;
  readonly brightBlack: string;
  readonly brightRed: string;
  readonly brightGreen: string;
  readonly brightYellow: string;
  readonly brightBlue: string;
  readonly brightMagenta: string;
  readonly brightCyan: string;
  readonly brightWhite: string;
}

export interface TerminalPalette {
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly selectionBackground: string;
  readonly ansi: TerminalAnsiPalette;
}

export type TerminalAppTheme = 'dark' | 'light';

export const TERMINAL_PALETTES: Readonly<Record<TerminalAppTheme, TerminalPalette>> = {
  dark: {
    background: '#0d0c0a', // --color-surface-container-lowest (dark)
    foreground: '#ece7df', // --color-on-surface (dark)
    cursor: '#f5a623', // --color-primary (dark)
    selectionBackground: '#262320', // --color-surface-container-high (dark)
    ansi: {
      black: '#6a6358',
      red: '#f87171',
      green: '#4ade80',
      yellow: '#f5a623',
      blue: '#7aa2f7',
      magenta: '#c792ea',
      cyan: '#6fd0bf',
      white: '#a8a196',
      brightBlack: '#847d70',
      brightRed: '#ff9e9e',
      brightGreen: '#86efac',
      brightYellow: '#ffd166',
      brightBlue: '#a9c1f7',
      brightMagenta: '#e0b3f4',
      brightCyan: '#9ee6d8',
      brightWhite: '#ece7df',
    },
  },
  light: {
    background: '#ffffff', // --color-surface-container-lowest (light)
    foreground: '#1e1b16', // --color-on-surface (light)
    cursor: '#8f5a00', // --color-primary (light)
    selectionBackground: '#e7e2d9', // --color-surface-container-high (light)
    ansi: {
      black: '#1e1b16',
      red: '#dc2626',
      green: '#15803d',
      yellow: '#8f5a00',
      blue: '#1e5fbf',
      magenta: '#8a3fae',
      cyan: '#0c7d6c',
      white: '#837d72',
      brightBlack: '#56514a',
      brightRed: '#b91c1c',
      brightGreen: '#0f6b30',
      brightYellow: '#b45309',
      brightBlue: '#164a94',
      brightMagenta: '#6d2e8c',
      brightCyan: '#095f52',
      brightWhite: '#8f897d',
    },
  },
};

/**
 * Builds xterm's `ITheme` for one app theme, so a terminal painted in either
 * theme matches the surface it sits on instead of carrying its own palette.
 *
 * @example
 * const term = new Terminal({ theme: buildTerminalTheme('dark') });
 */
export function buildTerminalTheme(appTheme: TerminalAppTheme): ITheme {
  const palette = TERMINAL_PALETTES[appTheme];
  return {
    background: palette.background,
    foreground: palette.foreground,
    cursor: palette.cursor,
    selectionBackground: palette.selectionBackground,
    ...palette.ansi,
  };
}

/** Pixel sizes matching `--chat-font-size` in `index.css` for each setting. */
const FONT_SIZE_PX: Readonly<Record<'small' | 'default' | 'large', number>> = {
  small: 13,
  default: 14,
  large: 16,
};

/**
 * Maps the chat font-size preference to a pixel size xterm accepts.
 *
 * @example
 * new Terminal({ fontSize: fontSizePx(useTheme().config.fontSize) });
 */
export function fontSizePx(size: 'small' | 'default' | 'large'): number {
  return FONT_SIZE_PX[size];
}
