import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { workflowFiles } from './support/workflow-files';

// Every external action must be pinned to an immutable 40-character commit
// SHA with a human-readable version comment, so a moved tag can never change
// what CI executes. Local reusable workflows and composite actions resolve to
// this repository's own checked-out commit and are exempt.
const PINNED_USES_PATTERN = /^[\w.-]+\/[\w./-]+@[a-f0-9]{40} # \S+/;

function actionManifest(actionDir: string): string {
  const yaml = join(actionDir, 'action.yaml');
  return existsSync(yaml) ? yaml : join(actionDir, 'action.yml');
}

function workflowAndActionFiles(): string[] {
  const actionsDir = join(ROOT_DIR, '.github', 'actions');
  return [
    ...workflowFiles().map((file) => join(ROOT_DIR, file)),
    ...readdirSync(actionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => actionManifest(join(actionsDir, entry.name))),
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
