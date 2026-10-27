import type { CodeThemeId } from '@/lib/code-themes';

type TokenType =
  'keyword' | 'identifier' | 'operator' | 'string' | 'punctuation' | 'functionName' | 'parameter';

const THEME_BACKGROUND: Record<CodeThemeId, string> = {
  'one-dark-pro': '#282c34',
  'github-dark-dimmed': '#22272e',
  'github-light': '#ffffff',
  'one-light': '#fafafa',
};

const TOKEN_COLORS: Record<CodeThemeId, Record<TokenType, string>> = {
  'one-dark-pro': {
    keyword: '#c678dd',
    identifier: '#e5c07b',
    operator: '#56b6c2',
    string: '#98c379',
    punctuation: '#abb2bf',
    functionName: '#61afef',
    parameter: '#e06c75',
  },
  'github-dark-dimmed': {
    keyword: '#f47067',
    identifier: '#f69d50',
    operator: '#adbac7',
    string: '#96d0ff',
    punctuation: '#adbac7',
    functionName: '#dcbdfb',
    parameter: '#f69d50',
  },
  'github-light': {
    keyword: '#cf222e',
    identifier: '#953800',
    operator: '#24292f',
    string: '#0a3069',
    punctuation: '#24292f',
    functionName: '#8250df',
    parameter: '#953800',
  },
  'one-light': {
    keyword: '#a626a4',
    identifier: '#c18401',
    operator: '#0184bc',
    string: '#50a14f',
    punctuation: '#383a42',
    functionName: '#4078f2',
    parameter: '#e45649',
  },
};

/**
 * A syntax-highlighted code sample drawn in the given Shiki theme's own colours.
 *
 * The background and token colours are literal on purpose: they show what a
 * code block will look like in that theme, so they must not follow the app's
 * tokens.
 */
export function ThemePreviewSample({ themeId }: { readonly themeId: CodeThemeId }) {
  const c = TOKEN_COLORS[themeId];

  return (
    <pre
      className="overflow-hidden p-3 font-mono text-micro leading-normal"
      style={{ background: THEME_BACKGROUND[themeId] }}
    >
      <code>
        <span style={{ color: c.keyword }}>const</span>{' '}
        <span style={{ color: c.identifier }}>greeting</span>{' '}
        <span style={{ color: c.operator }}>=</span>{' '}
        <span style={{ color: c.string }}>&quot;hello&quot;</span>
        <span style={{ color: c.punctuation }}>;</span>
        {'\n'}
        <span style={{ color: c.keyword }}>function</span>{' '}
        <span style={{ color: c.functionName }}>greet</span>
        <span style={{ color: c.punctuation }}>{'('}</span>
        <span style={{ color: c.parameter }}>name</span>
        <span style={{ color: c.punctuation }}>{')'}</span>{' '}
        <span style={{ color: c.punctuation }}>{'{'}</span>
        {'\n'} <span style={{ color: c.keyword }}>return</span>{' '}
        {/* eslint-disable-next-line no-template-curly-in-string -- Displayed code contains a literal template expression. */}
        <span style={{ color: c.string }}>{'\u0060\u0024{greeting}, \u0024{name}\u0060'}</span>
        <span style={{ color: c.punctuation }}>;</span>
        {'\n'}
        <span style={{ color: c.punctuation }}>{'}'}</span>
      </code>
    </pre>
  );
}
