import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import * as ts from '@typescript/typescript6';

import { queryRetryDelay, shouldRetryQuery } from '@/lib/environment-unavailable';
import { queryClient } from '@/lib/query-client';

const FRONTEND_ROOT = resolve(import.meta.dir, '../../..');
const FRONTEND_SRC = join(FRONTEND_ROOT, 'src');

/** A place a query opts in to polling while its tab is hidden. */
interface BackgroundPollingOverride {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Every `refetchIntervalInBackground` property in `source` whose value is not
 * the literal `false`.
 *
 * The default pins hidden tabs to no polling, but a per-query option wins over
 * it, so the default alone cannot say that no query polls in the background.
 * Parsed rather than matched with a regex, so a comment or a string that
 * mentions the option is not a hit, and a value that is not a literal (a
 * variable, a ternary) is, because it could be `true` at runtime.
 *
 * @example findBackgroundPollingOverrides('a.ts', 'x({ refetchIntervalInBackground: true })')
 * // [{ file: 'a.ts', line: 1, text: 'refetchIntervalInBackground: true' }]
 */
function findBackgroundPollingOverrides(
  file: string,
  source: string
): readonly BackgroundPollingOverride[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: BackgroundPollingOverride[] = [];

  const visit = (node: ts.Node): void => {
    const isOption =
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      node.name.getText(parsed) === 'refetchIntervalInBackground';
    const isLiteralFalse =
      ts.isPropertyAssignment(node) && node.initializer.kind === ts.SyntaxKind.FalseKeyword;
    if (isOption && !isLiteralFalse) {
      const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
      found.push({ file, line: line + 1, text: node.getText(parsed) });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => join(directory, entry));
}

describe('queryClient defaults', () => {
  it('is wired to the environment-aware retry policy and delay', () => {
    const queries = queryClient.getDefaultOptions().queries;
    expect(queries?.retry).toBe(shouldRetryQuery);
    expect(queries?.retryDelay).toBe(queryRetryDelay);
  });

  it('defaults interval refetches to paused while the tab is hidden', () => {
    // Polled queries (observability, runtime health, ChatGPT usage) set only
    // `refetchInterval` and rely on this default. It is half of the guarantee:
    // a per-query override beats it, which the call-site scan below covers.
    expect(queryClient.getDefaultOptions().queries?.refetchIntervalInBackground).toBe(false);
  });

  it('does not refetch on window focus, so realtime signals stay the refresh path', () => {
    expect(queryClient.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
  });
});

describe('hidden-tab polling call sites', () => {
  it('has no query that opts in to polling while the tab is hidden', () => {
    const files = sourceFilesUnder(FRONTEND_SRC);
    const sources = files.map((file) => ({ file, source: readFileSync(file, 'utf8') }));
    // Guards the scan against passing because it looked at nothing.
    const pollingFiles = sources.filter(({ source }) => source.includes('refetchInterval'));
    expect(
      pollingFiles.length,
      `expected files under ${FRONTEND_SRC} that set refetchInterval | received: ${pollingFiles.length}`
    ).toBeGreaterThan(0);

    const overrides = sources.flatMap(({ file, source }) =>
      findBackgroundPollingOverrides(relative(FRONTEND_ROOT, file), source)
    );

    expect(
      overrides.map(({ file, line, text }) => `${file}:${line} sets \`${text}\``),
      'expected no refetchIntervalInBackground other than the literal false | received: a query that polls while the tab is hidden'
    ).toEqual([]);
  });
});

describe('findBackgroundPollingOverrides', () => {
  it('reports a query that polls in the background, with its file and line', () => {
    const source = [
      'const options = {',
      '  queryKey: ["metrics"],',
      '  refetchInterval: 5_000,',
      '  refetchIntervalInBackground: true,',
      '};',
    ].join('\n');

    expect(findBackgroundPollingOverrides('metrics.ts', source)).toEqual([
      { file: 'metrics.ts', line: 4, text: 'refetchIntervalInBackground: true' },
    ]);
  });

  it('reports a value it cannot prove is false', () => {
    const source = [
      'const keepAlive = readSetting();',
      'a({ refetchIntervalInBackground: keepAlive });',
      'b({ refetchIntervalInBackground: isVisible ? false : true });',
      'c({ refetchIntervalInBackground });',
    ].join('\n');

    expect(findBackgroundPollingOverrides('dynamic.tsx', source).map(({ line }) => line)).toEqual([
      2, 3, 4,
    ]);
  });

  it('accepts the literal false and sources that never mention the option', () => {
    expect(
      findBackgroundPollingOverrides(
        'off.ts',
        'x({ refetchInterval: 1_000, refetchIntervalInBackground: false })'
      )
    ).toEqual([]);
    expect(findBackgroundPollingOverrides('plain.ts', 'x({ refetchInterval: 1_000 })')).toEqual([]);
  });

  it('ignores comments and strings that only mention the option', () => {
    const source = [
      '// refetchIntervalInBackground: true would poll hidden tabs',
      '/* refetchIntervalInBackground: true */',
      'const note = "refetchIntervalInBackground: true";',
    ].join('\n');

    expect(findBackgroundPollingOverrides('notes.ts', source)).toEqual([]);
  });
});
