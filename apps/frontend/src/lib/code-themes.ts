export const CODE_THEMES = [
  'one-dark-pro',
  'github-dark-dimmed',
  'github-light',
  'one-light',
] as const;

export type CodeThemeId = (typeof CODE_THEMES)[number];
