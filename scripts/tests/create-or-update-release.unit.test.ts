import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from '../lib/config';

const SCRIPT = join(ROOT_DIR, 'scripts/release/create-or-update-release.sh');

// Fake `gh` that logs every invocation. RELEASE_EXISTS / CREATE_THEN_EXIST /
// FAIL_CREATE / FAIL_EDIT / FAIL_UPLOAD inject the states the helper must
// handle. CREATE_THEN_EXIST models the wedge: create exits non-zero after the
// release appears server-side.
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  if [ -f "$RELEASE_MARK" ]; then
    exit 0
  fi
  if [ -n "\${RELEASE_EXISTS:-}" ]; then
    exit 0
  fi
  exit 1
fi
if [ "$1" = "release" ] && [ "$2" = "create" ]; then
  CREATE_COUNT="$(cat "$CREATE_COUNT_FILE")"
  CREATE_COUNT=$((CREATE_COUNT + 1))
  printf '%s' "$CREATE_COUNT" > "$CREATE_COUNT_FILE"
  if [ -n "\${CREATE_THEN_EXIST:-}" ] && [ "$CREATE_COUNT" -eq 1 ]; then
    touch "$RELEASE_MARK"
    echo "gh: created release, then connection reset while uploading assets" >&2
    exit 1
  fi
  if [ -n "\${FAIL_CREATE:-}" ]; then
    echo "gh: HTTP 500 Internal Server Error" >&2
    exit 1
  fi
  touch "$RELEASE_MARK"
  exit 0
fi
if [ "$1" = "release" ] && [ "$2" = "edit" ]; then
  if [ -n "\${FAIL_EDIT:-}" ]; then
    echo "gh: HTTP 502 Bad Gateway" >&2
    exit 1
  fi
  exit 0
fi
if [ "$1" = "release" ] && [ "$2" = "upload" ]; then
  if [ -n "\${FAIL_UPLOAD:-}" ]; then
    echo "gh: HTTP 422 already_exists" >&2
    exit 1
  fi
  exit 0
fi
if [ "$1" = "api" ]; then
  # upload_release_assets lists assets then uploads; empty listing is fine.
  exit 0
fi
exit 0
`;

const FAKE_SLEEP = `#!/usr/bin/env bash
printf 'sleep %s\\n' "$*" >> "$SLEEP_LOG"
`;

interface RunResult {
  exitCode: number;
  log: string[];
  sleepLog: string[];
  stderr: string;
}

function runCreateOrUpdateRelease(options: {
  args: string[];
  env?: Record<string, string | undefined>;
}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'create-or-update-release-'));
  try {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const ghPath = join(binDir, 'gh');
    writeFileSync(ghPath, FAKE_GH);
    chmodSync(ghPath, 0o755);
    const sleepPath = join(binDir, 'sleep');
    writeFileSync(sleepPath, FAKE_SLEEP);
    chmodSync(sleepPath, 0o755);

    const logPath = join(dir, 'gh.log');
    writeFileSync(logPath, '');
    const sleepLogPath = join(dir, 'sleep.log');
    writeFileSync(sleepLogPath, '');
    const releaseMark = join(dir, 'release.exists');
    const createCountFile = join(dir, 'create.count');
    writeFileSync(createCountFile, '0');

    const assetDir = join(dir, 'assets');
    mkdirSync(assetDir);
    const assetA = join(assetDir, 'a.tar.gz');
    const assetB = join(assetDir, 'b.zip');
    writeFileSync(assetA, 'a');
    writeFileSync(assetB, 'b');

    const resolvedArgs = options.args.map((arg) => {
      if (arg === 'ASSET_A') return assetA;
      if (arg === 'ASSET_B') return assetB;
      return arg;
    });
    const quotedArgs = resolvedArgs.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');

    const proc = Bun.spawnSync({
      cmd: [
        'bash',
        '-euo',
        'pipefail',
        '-c',
        `source "$1" && create_or_update_release ${quotedArgs}`,
        'bash',
        SCRIPT,
      ],
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_LOG: logPath,
        SLEEP_LOG: sleepLogPath,
        RELEASE_MARK: releaseMark,
        CREATE_COUNT_FILE: createCountFile,
        GITHUB_REPOSITORY: 'juliopolycarpo/mangostudio',
        ...options.env,
      },
      stderr: 'pipe',
    });
    const log = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    const sleepLog = readFileSync(sleepLogPath, 'utf8').split('\n').filter(Boolean);
    return { exitCode: proc.exitCode, log, sleepLog, stderr: proc.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('scripts/release/create-or-update-release.sh', () => {
  test('edits and uploads when the release already exists', () => {
    const result = runCreateOrUpdateRelease({
      args: [
        'v1.2.3',
        'ASSET_A',
        'ASSET_B',
        '--',
        '--title',
        'v1.2.3',
        '--notes-file',
        'RELEASE_NOTES.md',
      ],
      env: { RELEASE_EXISTS: '1' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.log[0]).toBe('release view v1.2.3');
    expect(result.log).toContain(
      'release edit v1.2.3 --title v1.2.3 --notes-file RELEASE_NOTES.md'
    );
    expect(result.log.some((line) => line.startsWith('release upload v1.2.3'))).toBe(true);
    expect(result.log.filter((line) => line.startsWith('release create'))).toEqual([]);
    expect(result.sleepLog).toEqual([]);
  });

  test('creates cleanly on the first attempt', () => {
    const result = runCreateOrUpdateRelease({
      args: ['v1.2.3', 'ASSET_A', '--', '--title', 'v1.2.3', '--notes-file', 'RELEASE_NOTES.md'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.log.filter((line) => line.startsWith('release view'))).toEqual([
      'release view v1.2.3',
    ]);
    expect(result.log.filter((line) => line.startsWith('release create'))).toHaveLength(1);
    expect(result.log.some((line) => line.startsWith('release create v1.2.3'))).toBe(true);
    expect(result.log.some((line) => line.includes('--notes-file RELEASE_NOTES.md'))).toBe(true);
    expect(result.log.filter((line) => line.startsWith('release edit'))).toEqual([]);
    expect(result.sleepLog).toEqual([]);
  });

  test('recovers when create succeeds server-side but exits non-zero', () => {
    const result = runCreateOrUpdateRelease({
      args: [
        'v0.1.1-canary',
        'ASSET_A',
        '--',
        '--prerelease',
        '--title',
        'v0.1.1-canary',
        '--notes',
        'Rolling canary build from abc. Canary version: 0.1.1-canary.abc1234.',
      ],
      env: { CREATE_THEN_EXIST: '1' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.log.filter((line) => line.startsWith('release create'))).toHaveLength(1);
    expect(result.log).toContain(
      'release edit v0.1.1-canary --prerelease --title v0.1.1-canary --notes Rolling canary build from abc. Canary version: 0.1.1-canary.abc1234.'
    );
    expect(result.log.some((line) => line.startsWith('release upload v0.1.1-canary'))).toBe(true);
    expect(result.sleepLog).toEqual([]);
  });

  test('preserves multi-word notes values through create and edit', () => {
    const notes = 'Rolling canary build from deadbeef. Canary version: 0.1.1-canary.deadbee.';
    const result = runCreateOrUpdateRelease({
      args: [
        'v0.1.1-canary',
        'ASSET_A',
        '--',
        '--prerelease',
        '--title',
        'v0.1.1-canary',
        '--notes',
        notes,
      ],
      env: { CREATE_THEN_EXIST: '1' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.log.some((line) => line.includes(`--notes ${notes}`))).toBe(true);
  });

  test('fails after three create attempts when the release never appears', () => {
    const result = runCreateOrUpdateRelease({
      args: ['v1.2.3', 'ASSET_A', '--', '--title', 'v1.2.3'],
      env: { FAIL_CREATE: '1' },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.log.filter((line) => line.startsWith('release create'))).toHaveLength(3);
    expect(result.log.filter((line) => line.startsWith('release edit'))).toEqual([]);
    expect(result.sleepLog).toEqual(['sleep 30', 'sleep 30']);
  });

  test('propagates edit failures on the existing-release path', () => {
    const result = runCreateOrUpdateRelease({
      args: ['v1.2.3', 'ASSET_A', '--', '--title', 'v1.2.3'],
      env: { RELEASE_EXISTS: '1', FAIL_EDIT: '1' },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.log.filter((line) => line.startsWith('release edit')).length).toBeGreaterThan(0);
    expect(result.log.filter((line) => line.startsWith('release upload'))).toEqual([]);
  });

  test('rejects a missing asset / flag separator', () => {
    const result = runCreateOrUpdateRelease({
      args: ['v1.2.3', 'ASSET_A', '--title', 'v1.2.3'],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('missing -- separator');
    expect(result.log).toEqual([]);
  });
});
