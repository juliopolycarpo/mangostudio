import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from '../lib/config';

const SCRIPT = join(ROOT_DIR, 'scripts/release/upload-release-assets.sh');

// Fake `gh` that logs every invocation and serves a canned asset listing for
// `gh api repos/.../releases/tags/...`. Asset rows come from FAKE_ASSETS_FILE
// as tab-separated "id<TAB>name" lines, matching the helper's --jq output.
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1" = "api" ] && [ "$2" != "--method" ]; then
  cat "$FAKE_ASSETS_FILE"
fi
exit 0
`;

interface RunResult {
  exitCode: number;
  log: string[];
  stderr: string;
}

function runUploadReleaseAssets(options: {
  args: string[];
  assetRows?: string[];
  env?: Record<string, string | undefined>;
}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'upload-release-assets-'));
  try {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const ghPath = join(binDir, 'gh');
    writeFileSync(ghPath, FAKE_GH);
    chmodSync(ghPath, 0o755);

    const logPath = join(dir, 'gh.log');
    writeFileSync(logPath, '');
    const assetsPath = join(dir, 'assets.tsv');
    writeFileSync(assetsPath, (options.assetRows ?? []).map((row) => `${row}\n`).join(''));

    const quotedArgs = options.args.map((arg) => `'${arg}'`).join(' ');
    const proc = Bun.spawnSync({
      cmd: [
        'bash',
        '-euo',
        'pipefail',
        '-c',
        `source "$1" && upload_release_assets ${quotedArgs}`,
        'bash',
        SCRIPT,
      ],
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_LOG: logPath,
        FAKE_ASSETS_FILE: assetsPath,
        GITHUB_REPOSITORY: 'juliopolycarpo/mangostudio',
        GH_REPO: undefined,
        ...options.env,
      },
      stderr: 'pipe',
    });
    const log = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    return { exitCode: proc.exitCode, log, stderr: proc.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('scripts/release/upload-release-assets.sh', () => {
  test('deletes every same-name asset by id before uploading with --clobber', () => {
    const result = runUploadReleaseAssets({
      args: ['v0.1.1-canary', 'assets/a.tar.gz', 'assets/b.zip'],
      assetRows: [
        '101\ta.tar.gz',
        '102\tunrelated.tar.gz',
        // Duplicate name: an asset wedged in GitHub's un-finalized "starter"
        // state alongside the uploaded one. Both must be deleted.
        '103\ta.tar.gz',
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.log).toEqual([
      'api repos/juliopolycarpo/mangostudio/releases/tags/v0.1.1-canary --jq .assets[] | [(.id | tostring), .name] | @tsv',
      'api --method DELETE repos/juliopolycarpo/mangostudio/releases/assets/101',
      'api --method DELETE repos/juliopolycarpo/mangostudio/releases/assets/103',
      'release upload v0.1.1-canary assets/a.tar.gz assets/b.zip --clobber',
    ]);
  });

  test('uploads directly when the release has no conflicting assets', () => {
    const result = runUploadReleaseAssets({
      args: ['v1.2.3', 'assets/a.tar.gz'],
      assetRows: ['102\tunrelated.tar.gz'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.log.filter((line) => line.includes('DELETE'))).toEqual([]);
    expect(result.log.at(-1)).toBe('release upload v1.2.3 assets/a.tar.gz --clobber');
  });

  test('GH_REPO overrides GITHUB_REPOSITORY for repo resolution', () => {
    const result = runUploadReleaseAssets({
      args: ['v1.2.3', 'assets/a.tar.gz'],
      env: { GH_REPO: 'someone/fork' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.log[0]).toContain('repos/someone/fork/releases/tags/v1.2.3');
  });

  test('fails fast when neither GH_REPO nor GITHUB_REPOSITORY is set', () => {
    const result = runUploadReleaseAssets({
      args: ['v1.2.3', 'assets/a.tar.gz'],
      env: { GITHUB_REPOSITORY: undefined },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('GH_REPO or GITHUB_REPOSITORY must be set');
    expect(result.log).toEqual([]);
  });
});
