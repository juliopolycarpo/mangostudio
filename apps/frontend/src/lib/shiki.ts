import { createHighlighter, type Highlighter } from 'shiki';

const PRELOADED_LANGS = [
  'typescript',
  'javascript',
  'python',
  'json',
  'xml',
  'css',
  'html',
  'sql',
  'bash',
  'yaml',
  'markdown',
  'tsx',
  'jsx',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'ruby',
  'php',
  'swift',
  'powershell',
] as const;

let highlighterPromise: Promise<Highlighter> | null = null;
let highlighterInstance: Highlighter | null = null;

export function initHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['one-dark-pro'],
      langs: [...PRELOADED_LANGS],
    }).then((h) => {
      highlighterInstance = h;
      return h;
    });
  }
  return highlighterPromise;
}

export function highlightCode(code: string, lang: string): string | null {
  if (!highlighterInstance) return null;
  try {
    return highlighterInstance.codeToHtml(code, {
      lang,
      theme: 'one-dark-pro',
    });
  } catch {
    // Unknown language — return null to fall back to plain rendering
    return null;
  }
}

// Start loading immediately on module import
void initHighlighter();
