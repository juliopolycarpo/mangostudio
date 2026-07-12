import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from '../lib/config';

const SCRIPT = join(ROOT_DIR, 'scripts/release/publish-summary.sh');

describe('publish-summary.sh', () => {
  test('renders channel status and optional auth/provenance rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'publish-summary-'));
    const summaryPath = join(dir, 'summary.md');
    writeFileSync(summaryPath, '');
    try {
      const proc = Bun.spawnSync({
        cmd: ['bash', SCRIPT, 'npm-publish=success', 'cargo-publish=failure'],
        cwd: ROOT_DIR,
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summaryPath,
          TITLE: 'Release 1.2.3',
          NPM_PUBLISH_AUTH: 'legacy-explicit',
          NPM_PUBLISH_PROVENANCE: 'explicit',
          NPM_CHANNEL_NAME: 'npm-publish',
          CARGO_PUBLISH_AUTH: 'failed',
        },
      });
      expect(proc.exitCode).toBe(0);
      const body = readFileSync(summaryPath, 'utf8');
      expect(body).toContain('## Release 1.2.3');
      expect(body).toContain('| `npm-publish` | ✅ success |');
      expect(body).toContain('re-run the `cargo-publish` job');
      expect(body).toContain('### Auth and provenance');
      expect(body).toContain('| `npm-publish` | legacy-explicit | explicit |');
      expect(body).toContain('| `cargo-publish` | failed | — |');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
