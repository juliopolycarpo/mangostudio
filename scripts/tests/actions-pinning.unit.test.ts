import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';

// Every external action must be pinned to an immutable 40-character commit
// SHA with a human-readable version comment, so a moved tag can never change
// what CI executes. Local reusable workflows and composite actions resolve to
// this repository's own checked-out commit and are exempt.
const PINNED_USES_PATTERN = /^[\w.-]+\/[\w./-]+@[a-f0-9]{40} # \S+/;

function workflowAndActionFiles(): string[] {
  const workflowsDir = join(ROOT_DIR, '.github', 'workflows');
  const actionsDir = join(ROOT_DIR, '.github', 'actions');
  return [
    ...readdirSync(workflowsDir)
      .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
      .map((file) => join(workflowsDir, file)),
    ...readdirSync(actionsDir).map((dir) => join(actionsDir, dir, 'action.yml')),
  ];
}

function collectUses(filePath: string): Array<{ line: number; value: string }> {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .flatMap((text, index) => {
      const value = /^\s*(?:-\s+)?uses:\s*(.+)$/.exec(text)?.[1]?.trim();
      return value ? [{ line: index + 1, value }] : [];
    });
}

describe('GitHub Actions pinning', () => {
  test('every external uses: is a full commit SHA with a version comment', () => {
    const files = workflowAndActionFiles();
    expect(files.length).toBeGreaterThan(0);

    for (const filePath of files) {
      for (const { line, value } of collectUses(filePath)) {
        if (value.startsWith('./')) continue;
        expect(
          PINNED_USES_PATTERN.test(value),
          `${filePath}:${line} — "${value}" must be pinned as owner/repo@<40-hex-sha> # <version>`
        ).toBe(true);
      }
    }
  });
});
