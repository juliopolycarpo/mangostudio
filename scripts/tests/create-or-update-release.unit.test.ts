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
//
// GH_LOG is space-joined for readable assertions, but space-joining erases
// argument boundaries: `--notes "a b"` and `--notes a b` log identically, so
// GH_LOG alone cannot catch a lost `"${flags[@]}"` quote. ARGV_LOG repeats
// each invocation with a `|` separator so boundaries stay observable.
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
(IFS='|'; printf '%s\\n' "$*" >> "$ARGV_LOG")
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
  /** Same invocations as `log`, `|`-separated so argument boundaries show. */
  argvLog: string[];
  sleepLog: string[];
  stderr: string;
}

function runCreateOrUpdateRelease(options: {
  args: string[];
  env?: Record<string, string | undefined>;
  /**
   * Call the helper from an `if` condition, which disables errexit for the
   * whole function body — the shape that exposes errexit-dependent failure
   * propagation. Exits 9 when the helper reports failure.
   */
  callInCondition?: boolean;
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
    const argvLogPath = join(dir, 'gh-argv.log');
    writeFileSync(argvLogPath, '');
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
    const call = `create_or_update_release ${quotedArgs}`;
    const script = options.callInCondition
      ? `source "$1" && if ${call}; then exit 0; else exit 9; fi`
      : `source "$1" && ${call}`;

    const proc = Bun.spawnSync({
      cmd: ['bash', '-euo', 'pipefail', '-c', script, 'bash', SCRIPT],
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        GH_LOG: logPath,
        ARGV_LOG: argvLogPath,
        SLEEP_LOG: sleepLogPath,
        RELEASE_MARK: releaseMark,
        CREATE_COUNT_FILE: createCountFile,
        GITHUB_REPOSITORY: 'juliopolycarpo/mangostudio',
        // Neutralize an ambient GH_REPO so upload_release_assets always
        // resolves the repo from GITHUB_REPOSITORY, as in CI.
        GH_REPO: undefined,
        ...options.env,
      },
      stderr: 'pipe',
    });
    const readLines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean);
    return {
      exitCode: proc.exitCode,
      log: readLines(logPath),
      argvLog: readLines(argvLogPath),
      sleepLog: readLines(sleepLogPath),
      stderr: proc.stderr.toString(),
    };
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
    // Asserted against the `|`-separated log: a lost quote around
    // "${flags[@]}" would split the notes into six arguments, which the
    // space-joined GH_LOG cannot distinguish from the correct single one.
    expect(result.argvLog.filter((line) => line.endsWith(`|--notes|${notes}`))).toHaveLength(2);
    expect(
      result.argvLog.filter((line) => line.startsWith('release|')).map((line) => line.split('|')[1])
    ).toEqual(['view', 'create', 'view', 'edit', 'upload']);
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

  test('propagates edit failures even when the caller disables errexit', () => {
    const result = runCreateOrUpdateRelease({
      args: ['v1.2.3', 'ASSET_A', '--', '--title', 'v1.2.3'],
      env: { RELEASE_EXISTS: '1', FAIL_EDIT: '1' },
      callInCondition: true,
    });

    // Without an explicit `|| return`, the failed edit would fall through and
    // upload assets onto a release whose title/notes never landed.
    expect(result.exitCode).toBe(9);
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

  test('rejects a call with no assets before touching the release', () => {
    const result = runCreateOrUpdateRelease({
      args: ['v1.2.3', '--', '--title', 'v1.2.3'],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('at least one asset is required');
    expect(result.log).toEqual([]);
  });
});
