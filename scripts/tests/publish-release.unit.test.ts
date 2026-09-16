import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_DIR } from '../lib/config';

const SCRIPT = join(ROOT_DIR, 'scripts/release/publish-release.sh');

// Fake `gh` backed by a state file, because every branch of the helper is a
// reaction to release *state* (missing / draft / published) rather than to an
// exit code alone. STATE_FILE is what a real repository would remember between
// two `gh` calls; ASSETS_FILE is the published asset list.
//
// GH_LOG is space-joined for readable assertions, but space-joining erases
// argument boundaries: `--notes "a b"` and `--notes a b` log identically, so
// GH_LOG alone cannot catch a lost `"${flags[@]}"` quote. ARGV_LOG repeats each
// invocation with a `|` separator so boundaries stay observable.
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GH_LOG"
(IFS='|'; printf '%s\\n' "$*" >> "$ARGV_LOG")
state="$(cat "$STATE_FILE")"

if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  if [ "$state" = "missing" ]; then
    echo "release not found" >&2
    exit 1
  fi
  case "$*" in
    *isDraft*) printf '%s\\n' "$state" ;;
    *assets*) cat "$ASSETS_FILE" ;;
  esac
  exit 0
fi

if [ "$1" = "release" ] && [ "$2" = "create" ]; then
  count="$(cat "$CREATE_COUNT_FILE")"
  count=$((count + 1))
  printf '%s' "$count" > "$CREATE_COUNT_FILE"
  if [ -n "\${CREATE_LEAVES_DRAFT:-}" ] && [ "$count" -eq 1 ]; then
    printf 'draft' > "$STATE_FILE"
    echo "gh: connection reset while uploading assets" >&2
    exit 1
  fi
  if [ -n "\${FAIL_CREATE:-}" ]; then
    echo "gh: HTTP 500 Internal Server Error" >&2
    exit 1
  fi
  # Record the asset basenames this call published: assets are paths, flags are not.
  : > "$ASSETS_FILE"
  for arg in "$@"; do
    case "$arg" in */*) basename "$arg" >> "$ASSETS_FILE" ;; esac
  done
  printf 'published' > "$STATE_FILE"
  exit 0
fi

if [ "$1" = "release" ] && [ "$2" = "delete" ]; then
  printf 'missing' > "$STATE_FILE"
  : > "$ASSETS_FILE"
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
  stdout: string;
  stderr: string;
}

function runPublishRelease(options: {
  args: string[];
  /** Release state the fake repository starts in: missing, draft or published. */
  state?: 'missing' | 'draft' | 'published';
  /** Asset names already attached when the release starts out published. */
  publishedAssets?: string[];
  env?: Record<string, string | undefined>;
  /**
   * Call the helper from an `if` condition, which disables errexit for the
   * whole function body — the shape that exposes errexit-dependent failure
   * propagation. Exits 9 when the helper reports failure.
   */
  callInCondition?: boolean;
}): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'publish-release-'));
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
    const statePath = join(dir, 'state');
    writeFileSync(statePath, options.state ?? 'missing');
    const assetsPath = join(dir, 'assets.list');
    writeFileSync(assetsPath, `${(options.publishedAssets ?? []).join('\n')}\n`);
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
    const call = `publish_release ${quotedArgs}`;
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
        STATE_FILE: statePath,
        ASSETS_FILE: assetsPath,
        CREATE_COUNT_FILE: createCountFile,
        GITHUB_REPOSITORY: 'juliopolycarpo/mangostudio',
        ...options.env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const readLines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean);
    return {
      exitCode: proc.exitCode,
      log: readLines(logPath),
      argvLog: readLines(argvLogPath),
      sleepLog: readLines(sleepLogPath),
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STANDARD_ARGS = [
  'v1.2.3-canary.abc1234',
  'ASSET_A',
  'ASSET_B',
  '--',
  '--prerelease',
  '--title',
  'v1.2.3-canary.abc1234',
  '--notes',
  'Canary build from abc1234',
];

describe('scripts/release/publish-release.sh', () => {
  test('publishes in a single create call, never an upload or an edit', () => {
    const result = runPublishRelease({ args: STANDARD_ARGS });

    expect(result.exitCode).toBe(0);
    expect(result.log.filter((line) => line.startsWith('release create'))).toHaveLength(1);
    // The immutability contract: assets ride along with create, which uploads
    // them to a draft and publishes last. An upload or edit against a
    // published release is the HTTP 422 this helper exists to avoid.
    expect(result.log.filter((line) => line.startsWith('release upload'))).toEqual([]);
    expect(result.log.filter((line) => line.startsWith('release edit'))).toEqual([]);
    expect(result.sleepLog).toEqual([]);
  });

  test('keeps flag arguments intact across the -- separator', () => {
    const result = runPublishRelease({ args: STANDARD_ARGS });

    const create = result.argvLog.find((line) => line.startsWith('release|create'));
    expect(create).toBeDefined();
    expect(create).toContain('|--notes|Canary build from abc1234');
    expect(create).toContain('|--prerelease|');
  });

  test('skips a release that is already published with every asset', () => {
    const result = runPublishRelease({
      args: STANDARD_ARGS,
      state: 'published',
      publishedAssets: ['a.tar.gz', 'b.zip'],
    });

    expect(result.exitCode).toBe(0);
    expect(result.log.filter((line) => line.startsWith('release create'))).toEqual([]);
    expect(result.stdout).toContain('already published');
  });

  test('fails on a published release that is missing an asset, since it cannot be repaired', () => {
    const result = runPublishRelease({
      args: STANDARD_ARGS,
      state: 'published',
      publishedAssets: ['a.tar.gz'],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain('b.zip');
    expect(result.stdout).toContain('immutable releases cannot be repaired');
    expect(result.log.filter((line) => line.startsWith('release create'))).toEqual([]);
  });

  test('deletes a leftover draft, keeping its tag, then publishes', () => {
    const result = runPublishRelease({ args: STANDARD_ARGS, state: 'draft' });

    expect(result.exitCode).toBe(0);
    const del = result.log.find((line) => line.startsWith('release delete'));
    // --cleanup-tag=false: deleting the tag is what the `release tags` ruleset
    // refuses, and `gh release create` reuses an existing tag anyway.
    expect(del).toBe('release delete v1.2.3-canary.abc1234 --yes --cleanup-tag=false');
    expect(result.log.filter((line) => line.startsWith('release create'))).toHaveLength(1);
  });

  test('recovers when a failed create leaves a draft behind', () => {
    const result = runPublishRelease({ args: STANDARD_ARGS, env: { CREATE_LEAVES_DRAFT: '1' } });

    expect(result.exitCode).toBe(0);
    expect(result.log.filter((line) => line.startsWith('release create'))).toHaveLength(2);
    expect(result.log.filter((line) => line.startsWith('release delete'))).toHaveLength(1);
    expect(result.sleepLog).toEqual(['sleep 30']);
  });

  test('gives up after three create attempts', () => {
    const result = runPublishRelease({
      args: STANDARD_ARGS,
      env: { FAIL_CREATE: '1' },
      callInCondition: true,
    });

    expect(result.exitCode).toBe(9);
    expect(result.log.filter((line) => line.startsWith('release create'))).toHaveLength(3);
    expect(result.sleepLog).toEqual(['sleep 30', 'sleep 30']);
    expect(result.stderr).toContain('after 3 attempts');
  });

  test('reports failure to a caller that disabled errexit', () => {
    const result = runPublishRelease({
      args: STANDARD_ARGS,
      state: 'published',
      publishedAssets: [],
      callInCondition: true,
    });

    expect(result.exitCode).toBe(9);
  });

  test('refuses a call with no assets', () => {
    const result = runPublishRelease({ args: ['v1.2.3', '--', '--prerelease'] });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('at least one asset is required');
    expect(result.log).toEqual([]);
  });

  test('refuses a call that omits the -- separator', () => {
    const result = runPublishRelease({ args: ['v1.2.3', 'ASSET_A', '--prerelease'] });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('missing -- separator');
    expect(result.log).toEqual([]);
  });
});
