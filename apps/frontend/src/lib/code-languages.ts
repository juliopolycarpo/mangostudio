/**
 * The fence languages the code highlighter can colour, and the names that map
 * to them. Kept apart from `shiki.ts` so code that runs at startup (the early
 * highlighter start in `MarkdownContent`) can ask "is this language supported?"
 * without importing the highlighter core, which is the thing it is deciding
 * whether to fetch.
 */
export const SHIKI_LANGUAGE_IDS = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'go',
  'html',
  'java',
  'javascript',
  'json',
  'jsx',
  'markdown',
  'php',
  'powershell',
  'python',
  'ruby',
  'rust',
  'sql',
  'swift',
  'tsx',
  'typescript',
  'xml',
  'yaml',
] as const;

export type ShikiLanguageId = (typeof SHIKI_LANGUAGE_IDS)[number];

const LANGUAGE_ALIASES: Readonly<Record<string, ShikiLanguageId>> = {
  'c++': 'cpp',
  cs: 'csharp',
  csh: 'csharp',
  htm: 'html',
  js: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
};

function isLanguageId(lang: string): lang is ShikiLanguageId {
  return (SHIKI_LANGUAGE_IDS as readonly string[]).includes(lang);
}

/**
 * The supported language a fence info string names, or `null`. Only the first
 * word counts ("ts title=a.ts" is `ts`), case does not, and inherited object
 * keys such as `constructor` are not languages.
 */
// Usage: resolveLanguageId('TS extra') === 'typescript'; resolveLanguageId('vue') === null
export function resolveLanguageId(lang: string): ShikiLanguageId | null {
  const language = lang.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (isLanguageId(language)) return language;
  return Object.hasOwn(LANGUAGE_ALIASES, language) ? (LANGUAGE_ALIASES[language] ?? null) : null;
}
