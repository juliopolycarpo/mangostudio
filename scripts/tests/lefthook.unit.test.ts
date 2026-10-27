import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';

function extractPreCommitCommand(config: string, command: string): string {
  return (
    new RegExp(`\\n    ${command}:\\n([\\s\\S]*?)(?=\\n    \\S|$)`).exec(`\n${config}`)?.[1] ?? ''
  );
}

describe('lefthook pre-commit config', () => {
  test('runs Bun lint and format in sequence for staged files without Dockerfiles', () => {
    const lefthook = readText('lefthook.yml');
    const lintHook = extractPreCommitCommand(lefthook, 'bun-lint');
    const formatHook = extractPreCommitCommand(lefthook, 'bun-fmt');

    expect(lefthook).toContain('parallel: false');
    expect(lintHook).toContain('run: bun lint --staged --fix --no-script --no-warn-ignored');
    expect(formatHook).toContain('run: bun fmt --staged');
    expect(formatHook).toContain(
      '*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,json,jsonc,css,html,md,mdc,mdx,toml,yml,yaml}'
    );
    expect(lefthook).not.toContain('dprint');
    expect(lefthook).not.toContain('Dockerfile');
    expect(lefthook.indexOf('    bun-lint:')).toBeLessThan(lefthook.indexOf('    bun-fmt:'));
  });

  test('configures OpenCode to use Bun fmt for code and documentation files', () => {
    const config = JSON.parse(readText('opencode.json')) as {
      formatter: Record<string, { command: string[]; extensions: string[] }>;
    };
    const formatter = config.formatter['bun-fmt'];

    expect(formatter.command).toEqual(['bun', 'fmt', '$FILE']);
    expect(formatter.extensions).toContain('.ts');
    expect(formatter.extensions).toContain('.jsonc');
    expect(formatter.extensions).toContain('.mdc');
    expect(formatter.extensions).toContain('.yaml');
    expect(readText('opencode.json')).not.toContain('Dockerfile');
  });

  test('runs affected workspace and code-health checks for staged files', () => {
    const lefthook = readText('lefthook.yml');
    const affectedCheck = extractPreCommitCommand(lefthook, 'check-affected');

    expect(affectedCheck).toContain('run: bun run check --staged --skip-format');
  });
});
