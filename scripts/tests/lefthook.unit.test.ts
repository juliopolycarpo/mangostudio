import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';

function extractPreCommitCommand(config: string, command: string): string {
  return (
    new RegExp(`\\n    ${command}:\\n([\\s\\S]*?)(?=\\n    \\S|$)`).exec(`\n${config}`)?.[1] ?? ''
  );
}

describe('lefthook pre-commit config', () => {
  test('lets dprint skip staged files excluded by dprint config', () => {
    const lefthook = readText('lefthook.yml');
    const dprintConfig = JSON.parse(readText('dprint.json')) as { excludes?: string[] };
    const dprintHook = extractPreCommitCommand(lefthook, 'dprint');

    expect(dprintConfig.excludes).toContain('**/CHANGELOG.md');
    expect(dprintHook).toContain('run: bunx dprint fmt --allow-no-files {staged_files}');
  });
});
