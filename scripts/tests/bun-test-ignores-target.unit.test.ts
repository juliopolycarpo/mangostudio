import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readText } from './support/read-text';

// `cargo semver-checks` leaves a baseline checkout of the whole repository under
// target/semver-checks. A lane filter like `packages/protocol` matches inside it,
// so a second copy of the suite ran and collided with the first on socket names.

const rootBunfig = Bun.TOML.parse(readText('bunfig.toml')) as {
  test?: { pathIgnorePatterns?: string[] };
};

const CASE_BODY = "import { it } from 'bun:test';\nit('collected', () => {});\n";

function writeCase(root: string, relative: string): void {
  const file = join(root, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, CASE_BODY);
}

describe('bun test discovery', () => {
  test('does not collect a test file under target/semver-checks', () => {
    const root = mkdtempSync(join(tmpdir(), 'bun-ignore-target-'));
    try {
      // Only the ignore patterns are copied: the real bunfig preloads repository files.
      const patterns = rootBunfig.test?.pathIgnorePatterns ?? [];
      writeFileSync(
        join(root, 'bunfig.toml'),
        `[test]\npathIgnorePatterns = ${JSON.stringify(patterns)}\n`
      );
      writeCase(root, 'packages/protocol/tests/real.test.ts');
      writeCase(root, 'target/semver-checks/git-x/abc123/packages/protocol/tests/stale.test.ts');

      const run = Bun.spawnSync([process.execPath, 'test', 'packages/protocol'], {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const output = `${run.stdout.toString()}${run.stderr.toString()}`;
      expect(
        output,
        `(bun test packages/protocol, pathIgnorePatterns ${JSON.stringify(patterns)}): expected 1 file, the one outside target/ | received: ${output}`
      ).toContain('across 1 file');
      expect(output).not.toContain('semver-checks');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
