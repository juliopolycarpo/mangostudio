import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { tarCreationCommand } from '../lib/archive-creation';

const INSTALL_SH = join(import.meta.dir, '..', 'install', 'install.sh');
const IS_WINDOWS = process.platform === 'win32';
const BASH = fixtureBash();

// These are Linux layout fixtures, even when native Bun runs them in Git Bash.
// The production installer still rejects the real Windows uname below.
const FIXTURE_LINUX_UNAME = `
fixture_linux_uname() {
  case "\${1:-}" in
    -s) printf 'Linux\\n' ;;
    -m) printf 'x86_64\\n' ;;
    *) command uname "$@" ;;
  esac
}
uname() { fixture_linux_uname "$@"; }
export -f fixture_linux_uname uname
`;

// Named fake of `curl` answering for api.github.com. It honours the flags the
// installer's release lookup uses, so it behaves like the real client whichever
// way the script asks: `-f` turns an HTTP error into curl exit 22, `-D <file>`
// receives the response headers, `-o <file>` the body (stdout otherwise), and
// `-w '%{http_code}'` prints the status after the body.
// The answer comes from FIXTURE_GITHUB_STATUS, FIXTURE_GITHUB_HEADERS (header
// lines joined by a literal \\r\\n) and FIXTURE_GITHUB_BODY.
// When FIXTURE_CURL_LOG names a file, every call appends its argv ('argv: ...')
// and, for \`--config -\`, the config read from stdin ('config: ...'), which is
// where the installer hands curl the Authorization header.
const FIXTURE_GITHUB_API_CURL = `
fixture_github_api_curl() {
  local headers_file='' body_file='' write_out='' fail_on_http_error=0 config_source=''
  if [ -n "\${FIXTURE_CURL_LOG:-}" ]; then printf 'argv: %s\\n' "$*" >> "$FIXTURE_CURL_LOG"; fi
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -K | --config) config_source="$2"; shift ;;
      -D) headers_file="$2"; shift ;;
      -o) body_file="$2"; shift ;;
      -w) write_out="$2"; shift ;;
      --*) ;;
      -*f*) fail_on_http_error=1 ;;
    esac
    shift
  done
  if [ "$config_source" = '-' ]; then
    # Always drain stdin, as curl does, so the installer's printf never meets a closed pipe.
    local config_text
    config_text="$(cat)"
    if [ -n "\${FIXTURE_CURL_LOG:-}" ]; then printf 'config: %s\\n' "$config_text" >> "$FIXTURE_CURL_LOG"; fi
  fi
  local status="\${FIXTURE_GITHUB_STATUS:-200}"
  if [ "$fail_on_http_error" = 1 ] && [ "$status" -ge 400 ]; then
    printf 'curl: (22) The requested URL returned error: %s\\n' "$status" >&2
    return 22
  fi
  if [ -n "$headers_file" ]; then
    printf 'HTTP/2 %s\\r\\n%b\\r\\n\\r\\n' "$status" "\${FIXTURE_GITHUB_HEADERS:-}" > "$headers_file"
  fi
  if [ -n "$body_file" ]; then
    printf '%s' "\${FIXTURE_GITHUB_BODY:-}" > "$body_file"
  else
    printf '%s' "\${FIXTURE_GITHUB_BODY:-}"
  fi
  case "$write_out" in *http_code*) printf '%s' "$status" ;; esac
}
curl() { fixture_github_api_curl "$@"; }
`;

/** Select Git Bash rather than the Windows WSL launcher, e.g. fixtureBash(). */
function fixtureBash(): string {
  const bash = Bun.which('bash');
  if (!IS_WINDOWS) return bash ?? 'bash';
  const git = Bun.which('git');
  const candidates = git
    ? [
        join(dirname(git), '..', 'bin', 'bash.exe'),
        join(dirname(git), '..', '..', 'bin', 'bash.exe'),
      ]
    : [];
  if (bash) candidates.push(bash);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const probe = Bun.spawnSync({ cmd: [candidate, '-c', 'uname -s'] });
    if (probe.exitCode === 0 && /^MINGW|^MSYS/.test(probe.stdout.toString())) return candidate;
  }
  throw new Error(
    `Invalid Bash candidates ${JSON.stringify(candidates)}; expected native Git Bash`
  );
}

/** Give Git Bash a POSIX path without a tar drive colon, e.g. shellPath('C:\\tmp\\file'). */
function shellPath(path: string): string {
  if (!IS_WINDOWS) return path;
  return path
    .replaceAll('\\', '/')
    .replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`);
}

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
});

function tempDir(prefix: string): string {
  // The long form: under an 8.3 short temp path the Windows shell reads a link back as
  // /tmp/..., which no longer matches the install root the script was given.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Execute the real POSIX shell with real symlinks, e.g. shell(['-c', 'uname -s']). */
function shell(args: string[], env: Record<string, string | undefined> = {}): RunResult {
  const shellEnv = { ...process.env, ...env };
  if (IS_WINDOWS) shellEnv.MSYS = 'winsymlinks:nativestrict';
  for (const key of ['MANGOSTUDIO_INSTALL_DIR', 'MANGOSTUDIO_BIN_DIR', 'TMPDIR']) {
    const value = shellEnv[key];
    if (value) shellEnv[key] = shellPath(value);
  }
  const result = Bun.spawnSync({
    cmd: [BASH, ...args],
    env: shellEnv as Record<string, string>,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function run(args: string[], env: Record<string, string | undefined>): RunResult {
  const command = [shellPath(INSTALL_SH), ...args.map(shellPath)];
  if (!IS_WINDOWS) return shell(command, env);
  return shell(
    ['-c', `${FIXTURE_LINUX_UNAME}\nexec "$BASH" "$@"`, 'linux-layout-fixture', ...command],
    env
  );
}

/** Call an internal function, e.g. sourceAndCall('swap_current "$1" 0.2.0', [root]). */
function sourceAndCall(expression: string, paths: string[] = [], linuxLayout = true): RunResult {
  const uname = IS_WINDOWS && linuxLayout ? FIXTURE_LINUX_UNAME : '';
  return shell([
    '-c',
    `${uname}\nsource "$1"; shift; ${expression}`,
    'installer-unit-fixture',
    shellPath(INSTALL_SH),
    ...paths.map(shellPath),
  ]);
}

/** Create the fixture link through its POSIX host, e.g. fixtureSymlink('0.1.0', current). */
function fixtureSymlink(target: string, link: string): void {
  const result = shell([
    '-c',
    'ln -s "$1" "$2"',
    'symlink-fixture',
    shellPath(target),
    shellPath(link),
  ]);
  if (result.exitCode !== 0) throw new Error(`Fixture symlink failed: ${JSON.stringify(result)}`);
}

let PLATFORM: string;

beforeAll(() => {
  const result = sourceAndCall('detect_platform');
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  PLATFORM = result.stdout.trim();
});

function makeFixtureBin(dir: string, printedVersion: string, execPath = 'mangostudio'): void {
  writeFileSync(join(dir, execPath), `#!/bin/sh\necho ${printedVersion}\n`);
  chmodSync(join(dir, execPath), 0o755);
}

/** Preserve fixture members and modes, e.g. createFixtureTar(archive, source, ['mangostudio']). */
function createFixtureTar(archivePath: string, directory: string, members: string[]): string {
  const { command, cwd } = tarCreationCommand(archivePath, [{ directory, members }]);
  const result = Bun.spawnSync({ cmd: [...command], cwd });
  if (result.exitCode !== 0) throw new Error(`tar failed: ${result.stderr.toString()}`);
  return archivePath;
}

/** A release archive shaped like archive-assets.ts produces: mangostudio at the root. */
function buildReleaseArchive(dir: string, name: string, printedVersion: string): string {
  const srcDir = join(dir, `src-${name}`);
  mkdirSync(srcDir, { recursive: true });
  makeFixtureBin(srcDir, printedVersion);
  return createFixtureTar(join(dir, name), srcDir, ['mangostudio']);
}

/**
 * A release archive whose mangostudio prints `stderr` (and `stdout`, when given) and exits
 * `exitCode` — a hub the OS cannot start, or one that prints its version and then fails.
 */
function buildFailingArchive(
  dir: string,
  name: string,
  failure: { readonly stderr: string; readonly exitCode: number; readonly stdout?: string }
): string {
  const srcDir = join(dir, `src-failing-${name}`);
  mkdirSync(srcDir, { recursive: true });
  const printStdout = failure.stdout === undefined ? '' : `printf '%s\\n' '${failure.stdout}'\n`;
  writeFileSync(
    join(srcDir, 'mangostudio'),
    `#!/bin/sh\n${printStdout}printf '%s\\n' '${failure.stderr}' >&2\nexit ${failure.exitCode}\n`
  );
  chmodSync(join(srcDir, 'mangostudio'), 0o755);
  return createFixtureTar(join(dir, name), srcDir, ['mangostudio']);
}

/**
 * A release archive whose mangostudio floods stderr (about 3 MB) and, before exiting 3, records
 * every file over 64 KiB under $TMPDIR into `leakReport`, to show where the installer kept it.
 */
function buildFloodingArchive(dir: string, name: string, leakReport: string): string {
  const srcDir = join(dir, `src-flooding-${name}`);
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(
    join(srcDir, 'mangostudio'),
    [
      '#!/bin/sh',
      'i=0',
      'while [ "$i" -lt 3000 ]; do printf \'%01000d\\n\' "$i" >&2; i=$((i + 1)); done',
      `find "$TMPDIR" -type f -size +64k > '${shellPath(leakReport)}'`,
      'exit 3',
      '',
    ].join('\n')
  );
  chmodSync(join(srcDir, 'mangostudio'), 0o755);
  return createFixtureTar(join(dir, name), srcDir, ['mangostudio']);
}

/** An npm platform tarball: members live under package/, per pack-npm.ts. */
function buildNpmTarball(dir: string, printedVersion: string): string {
  const srcDir = join(dir, 'npm-src');
  mkdirSync(join(srcDir, 'package'), { recursive: true });
  makeFixtureBin(join(srcDir, 'package'), printedVersion);
  return createFixtureTar(join(dir, 'mangostudio-npm.tgz'), srcDir, ['package']);
}

/** A broken archive with no `mangostudio` at all — extract_archive must fail() on it. */
function buildArchiveMissingBinary(dir: string, name: string): string {
  const srcDir = join(dir, `src-bad-${name}`);
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'not-mangostudio'), 'not a binary');
  return createFixtureTar(join(dir, name), srcDir, ['not-mangostudio']);
}

interface Layout {
  readonly workDir: string;
  readonly root: string;
  readonly bin: string;
  readonly env: Record<string, string>;
}

function layout(): Layout {
  const workDir = tempDir('mango-install-sh-');
  const root = join(workDir, 'root');
  const bin = join(workDir, 'bin');
  return {
    workDir,
    root,
    bin,
    env: { MANGOSTUDIO_INSTALL_DIR: shellPath(root), MANGOSTUDIO_BIN_DIR: shellPath(bin) },
  };
}

function originRecord(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'install-origin.json'), 'utf8'));
}

describe('install.sh layout', () => {
  test('current is a symlink to <version>, and the bin link points through it', () => {
    const { workDir, root, bin, env } = layout();
    const archive = buildReleaseArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, '0.1.0');

    const result = run(['--local', archive], env);

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(readlinkSync(join(root, 'current'))).toBe('0.1.0');
    expect(readlinkSync(join(bin, 'mangostudio'))).toBe(join(root, 'current', 'mangostudio'));
  });

  test('writes install-origin.json with the documented shape', () => {
    const { workDir, root, env } = layout();
    const archive = buildReleaseArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, '0.1.0');

    run(['--local', archive], env);
    const record = originRecord(root);

    expect(record).toMatchObject({
      origin: 'installer',
      channel: 'stable',
      version: '0.1.0',
      source: 'local-archive',
      binDir: env.MANGOSTUDIO_BIN_DIR,
    });
    expect(record.previousVersion).toBeUndefined();
    expect(typeof record.installedAt).toBe('string');
  });

  test('MANGOSTUDIO_INSTALL_ORIGIN=upgrade records origin: upgrade', () => {
    const { workDir, root, env } = layout();
    const archive = buildReleaseArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, '0.1.0');

    run(['--local', archive], { ...env, MANGOSTUDIO_INSTALL_ORIGIN: 'upgrade' });

    expect(originRecord(root).origin).toBe('upgrade');
  });

  test('--use swaps version and previousVersion without downloading', () => {
    const { workDir, root, env } = layout();
    const first = buildReleaseArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, '0.1.0');
    const second = buildReleaseArchive(workDir, `mangostudio-0.2.0-${PLATFORM}.tar.gz`, '0.2.0');
    run(['--local', first], env);
    run(['--local', second], env);
    expect(readlinkSync(join(root, 'current'))).toBe('0.2.0');

    const result = run(['--use', '0.1.0'], env);

    expect(result.exitCode).toBe(0);
    expect(readlinkSync(join(root, 'current'))).toBe('0.1.0');
    const record = originRecord(root);
    expect(record.version).toBe('0.1.0');
    expect(record.previousVersion).toBe('0.2.0');
  });

  test('reinstalling the same version (a repair install) carries the existing previousVersion forward', () => {
    const { workDir, root, env } = layout();
    const first = buildReleaseArchive(workDir, `mangostudio-1.0.0-${PLATFORM}.tar.gz`, '1.0.0');
    const second = buildReleaseArchive(workDir, `mangostudio-2.0.0-${PLATFORM}.tar.gz`, '2.0.0');
    run(['--local', first], env);
    run(['--local', second], env);
    expect(originRecord(root).previousVersion).toBe('1.0.0');

    // A repair install / retried upgrade: old_version === new_version, so
    // the pointer never actually moves. previousVersion must not collapse
    // onto 2.0.0 just because this install happened again.
    const result = run(['--local', second], env);

    expect(result.exitCode).toBe(0);
    expect(readlinkSync(join(root, 'current'))).toBe('2.0.0');
    expect(originRecord(root).previousVersion).toBe('1.0.0');
  });

  test('--rollback returns to the version --use came from', () => {
    const { workDir, root, env } = layout();
    const first = buildReleaseArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, '0.1.0');
    const second = buildReleaseArchive(workDir, `mangostudio-0.2.0-${PLATFORM}.tar.gz`, '0.2.0');
    run(['--local', first], env);
    run(['--local', second], env);
    run(['--use', '0.1.0'], env);

    const result = run(['--rollback'], env);

    expect(result.exitCode).toBe(0);
    expect(readlinkSync(join(root, 'current'))).toBe('0.2.0');
    expect(originRecord(root).previousVersion).toBe('0.1.0');
  });

  test('--rollback fails clearly when there is no previous version', () => {
    const { workDir, root, env } = layout();
    const archive = buildReleaseArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, '0.1.0');
    run(['--local', archive], env);

    const result = run(['--rollback'], env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no previous version recorded to roll back to');
    expect(readlinkSync(join(root, 'current'))).toBe('0.1.0');
  });

  test('migrates a legacy root (no current symlink, no origin file) on the next install', () => {
    const { workDir, root, bin, env } = layout();
    const legacyDir = join(root, '0.1.1');
    mkdirSync(legacyDir, { recursive: true });
    makeFixtureBin(legacyDir, '0.1.1');
    mkdirSync(bin, { recursive: true });
    fixtureSymlink(join(legacyDir, 'mangostudio'), join(bin, 'mangostudio'));

    const archive = buildReleaseArchive(workDir, `mangostudio-0.1.2-${PLATFORM}.tar.gz`, '0.1.2');
    const result = run(['--local', archive], env);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(legacyDir, 'mangostudio'))).toBe(true);
    expect(readlinkSync(join(root, 'current'))).toBe('0.1.2');
    expect(readlinkSync(join(bin, 'mangostudio'))).toBe(join(root, 'current', 'mangostudio'));
    expect(originRecord(root).previousVersion).toBe('0.1.1');
  });

  test('--prune keeps current and previous, removes other version directories, leaves the rest alone', () => {
    const { workDir, root, env } = layout();
    const first = buildReleaseArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, '0.1.0');
    const second = buildReleaseArchive(workDir, `mangostudio-0.2.0-${PLATFORM}.tar.gz`, '0.2.0');
    run(['--local', first], env);
    run(['--local', second], env);
    mkdirSync(join(root, '0.0.9'));
    mkdirSync(join(root, 'not-a-version'));
    writeFileSync(join(root, 'random-file.txt'), 'keep-me');

    const result = run(['--prune'], env);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, '0.0.9'))).toBe(false);
    expect(existsSync(join(root, '0.1.0'))).toBe(true);
    expect(existsSync(join(root, '0.2.0'))).toBe(true);
    expect(existsSync(join(root, 'not-a-version'))).toBe(true);
    expect(existsSync(join(root, 'random-file.txt'))).toBe(true);
  });

  test('--prune sweeps leftover .install-*/.staging-*/.rollback-* scratch directories', () => {
    // Left behind by an install/upgrade that failed before the swap
    // (extract_archive) or was interrupted mid-flight. None of them match
    // the version-directory pattern the main sweep looks for, so they
    // accumulate forever unless --prune sweeps them explicitly.
    const { workDir, root, env } = layout();
    const archive = buildReleaseArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, '0.1.0');
    run(['--local', archive], env);
    mkdirSync(join(root, '.install-0.2.0.1234'), { recursive: true });
    mkdirSync(join(root, '.staging-0.2.0-1234'), { recursive: true });
    mkdirSync(join(root, '.rollback-0.0.9-1234'), { recursive: true });

    const result = run(['--prune'], env);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, '.install-0.2.0.1234'))).toBe(false);
    expect(existsSync(join(root, '.staging-0.2.0-1234'))).toBe(false);
    expect(existsSync(join(root, '.rollback-0.0.9-1234'))).toBe(false);
    expect(existsSync(join(root, '0.1.0'))).toBe(true);
  });

  test('unknown lines in install-origin.json survive a rewrite', () => {
    const { workDir, root, env } = layout();
    const first = buildReleaseArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, '0.1.0');
    const second = buildReleaseArchive(workDir, `mangostudio-0.2.0-${PLATFORM}.tar.gz`, '0.2.0');
    run(['--local', first], env);
    run(['--local', second], env);

    const before = originRecord(root);
    writeFileSync(
      join(root, 'install-origin.json'),
      `${JSON.stringify({ ...before, futureField: 'keep-me' }, null, 2)}\n`
    );

    run(['--use', '0.1.0'], env);
    const after = originRecord(root);

    expect(after.futureField).toBe('keep-me');
    expect(after.version).toBe('0.1.0');
  });

  test('installs an npm platform tarball, stripping the package/ prefix, given an explicit version', () => {
    const { workDir, root, env } = layout();
    const tarball = buildNpmTarball(workDir, '0.4.0');

    const missingVersion = run(['--local', tarball], env);
    expect(missingVersion.exitCode).toBe(1);
    expect(missingVersion.stderr).toContain('--version');
    expect(missingVersion.stderr).toContain('MANGOSTUDIO_VERSION');

    const result = run(['--local', tarball, '--version', '0.4.0'], env);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, '0.4.0', 'mangostudio'))).toBe(true);
    expect(existsSync(join(root, '0.4.0', 'package'))).toBe(false);
    expect(originRecord(root).source).toBe('npm-registry');
  });

  test('a smoke mismatch fails with the expected/received shape and leaves the pointer untouched', () => {
    const { workDir, root, env } = layout();
    const good = buildReleaseArchive(workDir, `mangostudio-0.5.0-${PLATFORM}.tar.gz`, '0.5.0');
    run(['--local', good], env);

    const bad = buildReleaseArchive(workDir, `mangostudio-9.9.9-${PLATFORM}.tar.gz`, '9.9.9');

    const result = run(['--local', bad, '--version', '0.1.0'], env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('expected version: 0.1.0 | received: 9.9.9');
    expect(readlinkSync(join(root, 'current'))).toBe('0.5.0');
    expect(existsSync(join(root, '0.1.0'))).toBe(false);
  });

  test('a smoke mismatch re-installing an already-installed version never destroys the good directory', () => {
    const { workDir, root, env } = layout();
    const good = buildReleaseArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, '0.1.0');
    run(['--local', good], env);

    const bad = buildReleaseArchive(workDir, `mangostudio-9.9.9-${PLATFORM}.tar.gz`, '9.9.9');
    const result = run(['--local', bad, '--version', '0.1.0'], env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('expected version: 0.1.0 | received: 9.9.9');
    expect(readlinkSync(join(root, 'current'))).toBe('0.1.0');
    const survivingBinary = join(root, '0.1.0', 'mangostudio');
    const stillGood = IS_WINDOWS
      ? shell([shellPath(survivingBinary), '--version'])
      : Bun.spawnSync({ cmd: [survivingBinary, '--version'] });
    expect(stillGood.exitCode, stillGood.stderr.toString()).toBe(0);
    expect(stillGood.stdout.toString().trim()).toBe('0.1.0');
  });

  test('a smoke mismatch with a clean exit and no stderr keeps the original one-line error', () => {
    const { workDir, env } = layout();
    const bad = buildReleaseArchive(workDir, `mangostudio-9.9.9-${PLATFORM}.tar.gz`, '9.9.9');

    const result = run(['--local', bad, '--version', '0.1.0'], env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('Error: expected version: 0.1.0 | received: 9.9.9\n');
  });

  test('a hub the musl loader cannot start surfaces the loader output, exit status and the apk hint', () => {
    const { workDir, root, env } = layout();
    const good = buildReleaseArchive(workDir, `mangostudio-0.5.0-${PLATFORM}.tar.gz`, '0.5.0');
    run(['--local', good], env);
    const loaderLine =
      'Error loading shared library libstdc++.so.6: No such file or directory (needed by /x/mangostudio)';
    const broken = buildFailingArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, {
      stderr: loaderLine,
      exitCode: 127,
    });

    const result = run(['--local', broken, '--version', '0.1.0'], env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Error: expected version: 0.1.0 | received: <none>');
    expect(result.stderr, 'expected installer error to include loader output').toContain(
      loaderLine
    );
    expect(result.stderr, 'expected installer error to include the probe exit status').toContain(
      'expected: exit status: 0 | received: exit status: 127'
    );
    expect(result.stderr, 'expected installer error to include the apk hint').toContain(
      'apk add libstdc++'
    );
    expect(readlinkSync(join(root, 'current'))).toBe('0.5.0');
    expect(existsSync(join(root, '0.1.0'))).toBe(false);
  });

  test('a hub that fails for another reason shows its stderr and status without the apk hint', () => {
    const { workDir, root, env } = layout();
    const broken = buildFailingArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, {
      stderr: 'panic: corrupt embedded frontend',
      exitCode: 3,
    });

    const result = run(['--local', broken, '--version', '0.1.0'], env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('expected version: 0.1.0 | received: <none>');
    expect(result.stderr).toContain('panic: corrupt embedded frontend');
    expect(result.stderr).toContain('exit status: 3');
    expect(result.stderr).not.toContain('apk add');
    expect(existsSync(join(root, 'current'))).toBe(false);
  });

  test('a hub that prints the expected version but exits non-zero fails the install', () => {
    const { workDir, root, env } = layout();
    const broken = buildFailingArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, {
      stdout: '0.1.0',
      stderr: 'panic: crashed after printing the version',
      exitCode: 3,
    });

    const result = run(['--local', broken, '--version', '0.1.0'], env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('expected version: 0.1.0 | received: <none>');
    expect(result.stderr).toContain('expected: exit status: 0 | received: exit status: 3');
    expect(existsSync(join(root, 'current'))).toBe(false);
    expect(existsSync(join(root, '0.1.0'))).toBe(false);
  });

  test('a glibc loader error is shown but never gets the apk hint', () => {
    const { workDir, env } = layout();
    const glibcLine =
      'mangostudio: error while loading shared libraries: libstdc++.so.6: cannot open shared object file';
    const broken = buildFailingArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, {
      stderr: glibcLine,
      exitCode: 127,
    });

    const result = run(['--local', broken, '--version', '0.1.0'], env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(glibcLine);
    expect(result.stderr).not.toContain('apk add');
  });

  test('a hub that floods stderr is capped at ten lines and never spooled to disk', () => {
    const { workDir, env } = layout();
    const scratchTmp = join(workDir, 'tmp');
    mkdirSync(scratchTmp, { recursive: true });
    const leakReport = join(workDir, 'leaked-files.txt');
    const flooding = buildFloodingArchive(
      workDir,
      `mangostudio-0.1.0-${PLATFORM}.tar.gz`,
      leakReport
    );

    const result = run(['--local', flooding, '--version', '0.1.0'], {
      ...env,
      TMPDIR: scratchTmp,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('exit status: 3');
    const floodLines = result.stderr
      .split('\n')
      .filter((line) => /^0+\d*$/.test(line.replace('  stderr: ', '')));
    expect(
      floodLines.length,
      'expected at most 10 stderr lines shown | received'
    ).toBeLessThanOrEqual(10);
    expect(
      readFileSync(leakReport, 'utf8').trim(),
      'expected no file over 64 KiB under TMPDIR while the probe ran | received'
    ).toBe('');
  });

  test('an archive missing mangostudio fails and leaves no .install-* scratch directory behind', () => {
    const { workDir, root, env } = layout();
    const bad = buildArchiveMissingBinary(workDir, 'mangostudio-9.9.9-bad.tar.gz');

    const result = run(['--local', bad, '--version', '9.9.9'], env);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('archive is missing mangostudio');
    const leftovers = existsSync(root)
      ? readdirSync(root).filter((name) => name.startsWith('.install-'))
      : [];
    expect(leftovers).toEqual([]);
  });

  test('--uninstall removes the install root and the linked binary', () => {
    const { workDir, root, bin, env } = layout();
    const archive = buildReleaseArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, '0.1.0');
    run(['--local', archive], env);

    const result = run(['--uninstall'], env);

    expect(result.exitCode).toBe(0);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(bin, 'mangostudio'))).toBe(false);
  });

  test('--uninstall leaves a bin link that points outside the install root alone', () => {
    const { workDir, bin, env } = layout();
    const archive = buildReleaseArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, '0.1.0');
    run(['--local', archive], env);
    rmSync(join(bin, 'mangostudio'));
    mkdirSync(bin, { recursive: true });
    const elsewhere = join(workDir, 'elsewhere-mangostudio');
    writeFileSync(elsewhere, '');
    fixtureSymlink(elsewhere, join(bin, 'mangostudio'));

    run(['--uninstall'], env);

    expect(existsSync(join(bin, 'mangostudio'))).toBe(true);
  });
});

describe('install.sh internals (network-free)', () => {
  test('the Linux layout fixture keeps production Windows platform rejection intact', () => {
    const nativePlatform = sourceAndCall('detect_platform', [], false);
    if (!IS_WINDOWS) {
      expect(nativePlatform.exitCode, JSON.stringify(nativePlatform)).toBe(0);
      expect(nativePlatform.stdout.trim()).toBe(PLATFORM);
      return;
    }
    expect(nativePlatform.exitCode).toBe(1);
    expect(nativePlatform.stderr).toContain('unsupported OS:');
    expect(PLATFORM).toBe('linux-x64');
  });

  test.each([
    { name: 'empty response', payload: '' },
    {
      name: 'partial redirect URL',
      payload: 'https://github.com/juliopolycarpo/mangostudio/releases/tag/v9.9.9',
    },
  ])('failed stable lookup rejects $name and preserves curl failure', ({ payload }) => {
    const result = sourceAndCall(`
      fixture_failed_redirect() {
        printf 'curl: (22) The requested URL returned error: 403\\n' >&2
        printf '%s' '${payload}'
        return 22
      }
      curl() { fixture_failed_redirect "$@"; }
      version="$(resolve_latest_version)"
      printf 'resolved=%s\\n' "$version"
    `);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('curl: (22) The requested URL returned error: 403');
    expect(result.stderr).toContain('failed to fetch latest release');
    expect(result.stderr).not.toContain('version is empty');
    expect(result.stdout).toBe('');
  });

  test('successful stable lookup normalizes the redirect tag', () => {
    const result = sourceAndCall(`
      fixture_latest_redirect() {
        printf '%s' 'https://github.com/juliopolycarpo/mangostudio/releases/tag/v0.1.2'
      }
      curl() { fixture_latest_redirect "$@"; }
      version="$(resolve_latest_version)"
      printf '%s\\n' "$version"
    `);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('0.1.2');
  });

  test.each([
    { name: 'empty response', payload: '' },
    { name: 'partial response with a tag', payload: '[{"tag_name":"v0.1.1-canary.abc1234"}]' },
  ])('failed canary lookup rejects $name and preserves curl failure', ({ payload }) => {
    const result = sourceAndCall(`
      fixture_failed_curl() {
        printf 'curl: (22) The requested URL returned error: 403\\n' >&2
        printf '%s' '${payload}'
        return 22
      }
      curl() { fixture_failed_curl "$@"; }
      tag="$(resolve_canary_tag)"
      printf 'resolved=%s\\n' "$tag"
    `);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('curl: (22) The requested URL returned error: 403');
    expect(result.stderr).toContain('failed to fetch canary releases');
    expect(result.stderr).not.toContain('no canary release found');
    expect(result.stdout).toBe('');
  });

  interface GithubAnswer {
    readonly status: number;
    readonly headers?: readonly string[];
    readonly body?: string;
  }

  // A sentinel no real token looks like, so any leak into output is a plain substring match.
  const TOKEN = 'ghp_FIXTURE_TOKEN_MUST_NOT_PRINT';

  interface GithubLookupOptions {
    /** Token variables exported to the installer; defaults to GITHUB_TOKEN=TOKEN. */
    readonly tokens?: Readonly<Record<string, string>>;
    /** Where the fake curl appends each call's argv and stdin config. */
    readonly curlLog?: string;
  }

  /** Run resolve_canary_tag against the named api.github.com fake, e.g. resolveCanaryFromGithub({ status: 200, body: '[]' }). */
  function resolveCanaryFromGithub(
    answer: GithubAnswer,
    options: GithubLookupOptions = {}
  ): RunResult {
    const headers = (answer.headers ?? []).join('\\r\\n');
    const tokens = options.tokens ?? { GITHUB_TOKEN: TOKEN };
    const exports = Object.entries(tokens)
      .map(([name, value]) => `export ${name}='${value}'`)
      .join('\n');
    const log = options.curlLog ? `export FIXTURE_CURL_LOG='${shellPath(options.curlLog)}'` : '';
    return sourceAndCall(`
      ${FIXTURE_GITHUB_API_CURL}
      export FIXTURE_GITHUB_STATUS='${answer.status}'
      export FIXTURE_GITHUB_HEADERS='${headers}'
      export FIXTURE_GITHUB_BODY='${answer.body ?? ''}'
      ${log}
      # Start from a clean slate: the test host's own tokens must not decide the case.
      unset GITHUB_TOKEN GH_TOKEN
      ${exports}
      tag="$(resolve_canary_tag)"
      printf '%s\\n' "$tag"
    `);
  }

  /** A fresh, empty fake-curl log, e.g. const log = newCurlLog(). */
  function newCurlLog(): string {
    const log = join(tempDir('mango-curl-log-'), 'curl.log');
    writeFileSync(log, '');
    return log;
  }

  const CANARY_BODY = '[{"tag_name":"v0.1.1-canary.abc1234"}]';

  const RESET_EPOCH = 1790000000;
  const RESET_UTC = '2026-09-21T14:13:20Z';

  test('successful empty canary lookup reports no matching release', () => {
    const result = resolveCanaryFromGithub({ status: 200, body: '[]' });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no canary release found');
    expect(result.stderr).not.toContain('failed to fetch');
    expect(result.stderr).not.toContain('rate limit');
    expect(result.stdout).toBe('');
  });

  test('successful canary lookup returns the newest tag', () => {
    const result = resolveCanaryFromGithub({
      status: 200,
      body: '[{"tag_name":"v0.1.1-canary.abc1234"}]',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('v0.1.1-canary.abc1234');
  });

  test('a rate-limited canary lookup names the status, the reset time, and how to proceed', () => {
    const result = resolveCanaryFromGithub({
      status: 403,
      headers: ['x-ratelimit-remaining: 0', `x-ratelimit-reset: ${RESET_EPOCH}`],
      body: '{"message":"API rate limit exceeded for 203.0.113.7."}',
    });

    expect(result.exitCode, JSON.stringify(result)).toBe(1);
    expect(result.stderr).toContain('GitHub API rate limit exceeded (HTTP 403)');
    expect(result.stderr).toContain(`resets at ${RESET_UTC}`);
    expect(result.stderr).toContain('run the installer again');
    expect(result.stderr).not.toContain('no canary release found');
    expect(result.stderr).not.toContain(TOKEN);
    expect(result.stdout).toBe('');
  });

  test('a secondary-limit 429 without a reset header still reads as a rate limit', () => {
    const result = resolveCanaryFromGithub({ status: 429, headers: ['retry-after: 60'] });

    expect(result.exitCode, JSON.stringify(result)).toBe(1);
    expect(result.stderr).toContain('GitHub API rate limit exceeded (HTTP 429)');
    expect(result.stderr).not.toContain('resets at');
    expect(result.stderr).not.toContain('no canary release found');
  });

  test('a 403 that is not a rate limit is reported as an API refusal, not a rate limit', () => {
    const result = resolveCanaryFromGithub({
      status: 403,
      headers: ['x-ratelimit-remaining: 42', `x-ratelimit-reset: ${RESET_EPOCH}`],
    });

    expect(result.exitCode, JSON.stringify(result)).toBe(1);
    expect(result.stderr).toContain('GitHub API request failed (HTTP 403)');
    expect(result.stderr).not.toContain('rate limit');
    expect(result.stderr).not.toContain('no canary release found');
  });

  test('a server error from the releases API is reported with its status', () => {
    const result = resolveCanaryFromGithub({ status: 502 });

    expect(result.exitCode, JSON.stringify(result)).toBe(1);
    expect(result.stderr).toContain('GitHub API request failed (HTTP 502)');
    expect(result.stderr).not.toContain('no canary release found');
  });

  describe('GitHub API authentication', () => {
    const AUTH_CONFIG = `config: header = "Authorization: Bearer ${TOKEN}"`;
    const OTHER_TOKEN = 'ghp_FIXTURE_OTHER_TOKEN_MUST_NOT_PRINT';

    /** The lines the fake curl logged, e.g. readCurlLog(log).filter((line) => line.startsWith('argv:')). */
    function readCurlLog(log: string): string[] {
      return readFileSync(log, 'utf8').split('\n').filter(Boolean);
    }

    /** Assert the token reached neither output stream nor any curl argv. */
    function expectTokenOnlyInConfig(result: RunResult, log: string, token = TOKEN): void {
      expect(result.stdout).not.toContain(token);
      expect(result.stderr).not.toContain(token);
      for (const line of readCurlLog(log).filter((entry) => entry.startsWith('argv:'))) {
        expect(line, `curl argv must not carry the token: ${line}`).not.toContain(token);
      }
    }

    test('GITHUB_TOKEN is sent to the releases API as a Bearer header read from stdin', () => {
      const log = newCurlLog();
      const result = resolveCanaryFromGithub({ status: 200, body: CANARY_BODY }, { curlLog: log });

      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      expect(result.stdout.trim()).toBe('v0.1.1-canary.abc1234');
      const entries = readCurlLog(log);
      expect(entries).toContain(AUTH_CONFIG);
      const argv = entries.find((entry) => entry.startsWith('argv:')) ?? '';
      expect(argv).toContain('--config -');
      expect(argv).toContain('https://api.github.com/repos/juliopolycarpo/mangostudio/releases');
      expect(argv).not.toContain('Authorization');
      expectTokenOnlyInConfig(result, log);
    });

    test('GH_TOKEN is used when GITHUB_TOKEN is unset', () => {
      const log = newCurlLog();
      const result = resolveCanaryFromGithub(
        { status: 200, body: CANARY_BODY },
        { curlLog: log, tokens: { GH_TOKEN: TOKEN } }
      );

      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      expect(readCurlLog(log)).toContain(AUTH_CONFIG);
      expectTokenOnlyInConfig(result, log);
    });

    test('an empty GITHUB_TOKEN falls back to GH_TOKEN', () => {
      const log = newCurlLog();
      const result = resolveCanaryFromGithub(
        { status: 200, body: CANARY_BODY },
        { curlLog: log, tokens: { GITHUB_TOKEN: '', GH_TOKEN: TOKEN } }
      );

      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      expect(readCurlLog(log)).toContain(AUTH_CONFIG);
    });

    test('GITHUB_TOKEN wins over GH_TOKEN when both are set', () => {
      const log = newCurlLog();
      const result = resolveCanaryFromGithub(
        { status: 200, body: CANARY_BODY },
        { curlLog: log, tokens: { GITHUB_TOKEN: TOKEN, GH_TOKEN: OTHER_TOKEN } }
      );

      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      const entries = readCurlLog(log);
      expect(entries).toContain(AUTH_CONFIG);
      expect(entries.join('\n')).not.toContain(OTHER_TOKEN);
    });

    test('no token sends no Authorization header and no curl config', () => {
      const log = newCurlLog();
      const result = resolveCanaryFromGithub(
        { status: 200, body: CANARY_BODY },
        { curlLog: log, tokens: {} }
      );

      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      const logged = readCurlLog(log).join('\n');
      expect(logged).toContain('argv:');
      expect(logged).not.toContain('config:');
      expect(logged).not.toContain('--config');
      expect(logged).not.toContain('Authorization');
    });

    test('release asset downloads never receive the token', () => {
      const log = newCurlLog();
      const result = sourceAndCall(`
        ${FIXTURE_GITHUB_API_CURL}
        export FIXTURE_CURL_LOG='${shellPath(log)}'
        export GITHUB_TOKEN='${TOKEN}'
        export GH_TOKEN='${OTHER_TOKEN}'
        # Load the token as the installer does, so a download routed through
        # github_api_curl would carry it and fail this test.
        load_github_api_token
        scratch="$(mktemp -d)"
        curl_download 'https://github.com/juliopolycarpo/mangostudio/releases/download/v0.1.1/SHA256SUMS' "$scratch/SHA256SUMS"
        rm -rf "$scratch"
      `);

      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      const logged = readCurlLog(log).join('\n');
      expect(logged).toContain('argv:');
      expect(logged).not.toContain('config:');
      expect(logged).not.toContain('--config');
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain(OTHER_TOKEN);
      expect(result.stdout + result.stderr).not.toContain(TOKEN);
    });

    const RATE_LIMITED: GithubAnswer = {
      status: 403,
      headers: ['x-ratelimit-remaining: 0', `x-ratelimit-reset: ${RESET_EPOCH}`],
    };

    test('an anonymous rate-limited lookup suggests setting GITHUB_TOKEN', () => {
      const result = resolveCanaryFromGithub(RATE_LIMITED, { tokens: {} });

      expect(result.exitCode, JSON.stringify(result)).toBe(1);
      expect(result.stderr).toContain('GitHub API rate limit exceeded (HTTP 403)');
      expect(result.stderr).toContain('set GITHUB_TOKEN');
    });

    test('a rate-limited lookup that already sent a token does not suggest one', () => {
      const result = resolveCanaryFromGithub(RATE_LIMITED, { tokens: { GH_TOKEN: TOKEN } });

      expect(result.exitCode, JSON.stringify(result)).toBe(1);
      expect(result.stderr).toContain('GitHub API rate limit exceeded (HTTP 403)');
      expect(result.stderr).not.toContain('GITHUB_TOKEN');
      expect(result.stderr).not.toContain(TOKEN);
    });

    test.each([
      { name: 'a space', token: 'ghp_has space' },
      { name: 'a double quote', token: 'ghp_has"quote' },
      { name: 'a backslash', token: 'ghp_has\\\\slash' },
    ])(
      'a token containing $name is refused before any request, without echoing it',
      ({ token }) => {
        const log = newCurlLog();
        const result = resolveCanaryFromGithub(
          { status: 200, body: CANARY_BODY },
          { curlLog: log, tokens: { GITHUB_TOKEN: token } }
        );

        expect(result.exitCode, JSON.stringify(result)).toBe(1);
        expect(result.stderr).toContain('GITHUB_TOKEN/GH_TOKEN contains whitespace');
        expect(result.stderr).not.toContain('failed to fetch canary releases');
        expect(result.stderr).not.toContain('ghp_has');
        expect(readCurlLog(log)).toEqual([]);
      }
    );

    // Real curl against two local origins (different ports are different
    // origins): the first answers 302 to the second. The installer's `-L` must
    // keep the Authorization header on the first and drop it on the second.
    test.skipIf(IS_WINDOWS)(
      'real curl sends the header to the API origin and drops it on a cross-origin redirect',
      async () => {
        const seen: { origin: string; authorization: string | null }[] = [];
        const target = Bun.serve({
          port: 0,
          fetch(request) {
            seen.push({ origin: 'target', authorization: request.headers.get('authorization') });
            return new Response(CANARY_BODY, { headers: { 'content-type': 'application/json' } });
          },
        });
        const api = Bun.serve({
          port: 0,
          fetch(request) {
            seen.push({ origin: 'api', authorization: request.headers.get('authorization') });
            return Response.redirect(`http://127.0.0.1:${target.port}/releases`, 302);
          },
        });
        try {
          const child = Bun.spawn({
            cmd: [
              BASH,
              '-c',
              'source "$1"; GITHUB_API="http://127.0.0.1:$2/repos/x"; unset GH_TOKEN; export GITHUB_TOKEN="$3"; resolve_canary_tag',
              'real-curl-fixture',
              shellPath(INSTALL_SH),
              String(api.port),
              TOKEN,
            ],
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);

          expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
          expect(stdout.trim()).toBe('v0.1.1-canary.abc1234');
          expect(seen).toEqual([
            { origin: 'api', authorization: `Bearer ${TOKEN}` },
            { origin: 'target', authorization: null },
          ]);
        } finally {
          await api.stop(true);
          await target.stop(true);
        }
      }
    );
  });

  test('extract_canary_tag picks the newest per-commit canary tag_name', () => {
    // GitHub lists newest first, and canary now cuts one release per green
    // commit, so the first match is the build to install.
    const releasesJson = JSON.stringify([
      { tag_name: 'v0.1.2', prerelease: false },
      { tag_name: 'v0.1.1-canary.abc1234', prerelease: true },
      { tag_name: 'v0.1.1-canary.9876543', prerelease: true },
      { tag_name: 'v0.1.0', prerelease: false },
    ]);

    const result = sourceAndCall(`extract_canary_tag '${releasesJson}'`);

    expect(result.stdout.trim()).toBe('v0.1.1-canary.abc1234');
  });

  test('extract_canary_tag accepts a git-describe style sha identifier', () => {
    // A short sha that is all digits with a leading zero is an illegal semver
    // numeric identifier, so the release scripts write it `g`-prefixed.
    const releasesJson = JSON.stringify([{ tag_name: 'v0.1.1-canary.g0123456', prerelease: true }]);

    const result = sourceAndCall(`extract_canary_tag '${releasesJson}'`);

    expect(result.stdout.trim()).toBe('v0.1.1-canary.g0123456');
  });

  test('extract_canary_tag still resolves the frozen rolling tag', () => {
    // Pre-2026-09 releases carry no sha suffix. The release is immutable and
    // still serves the last rolling build, so an old install must keep working.
    const releasesJson = JSON.stringify([
      { tag_name: 'v0.1.2', prerelease: false },
      { tag_name: 'v0.1.1-canary', prerelease: true },
    ]);

    const result = sourceAndCall(`extract_canary_tag '${releasesJson}'`);

    expect(result.stdout.trim()).toBe('v0.1.1-canary');
  });

  test('extract_canary_tag prints nothing when there is no canary release', () => {
    const releasesJson = JSON.stringify([{ tag_name: 'v0.1.2', prerelease: false }]);

    const result = sourceAndCall(`extract_canary_tag '${releasesJson}'`);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  test('swap_current replaces the pointer without ever unlinking it first', () => {
    const root = tempDir('mango-swap-');
    mkdirSync(join(root, '0.1.0'));
    mkdirSync(join(root, '0.2.0'));
    fixtureSymlink('0.1.0', join(root, 'current'));

    const result = sourceAndCall('swap_current "$1" 0.2.0', [root]);

    expect(result.exitCode).toBe(0);
    expect(readlinkSync(join(root, 'current'))).toBe('0.2.0');
    // A `mv` that followed the old link would have dropped the temporary
    // inside the version directory instead of replacing the pointer.
    expect(readdirSync(join(root, '0.1.0'))).toEqual([]);
    expect(readdirSync(root).filter((entry) => entry.startsWith('.current.'))).toEqual([]);
  });

  test('swap_current leaves nothing behind when the pointer is recreated mid-swap', () => {
    // The concurrent case, made deterministic: `rm` is a no-op, standing in
    // for a second process putting `current` back between the unlink and the
    // move. `mv -f` then stats the destination, sees a directory through the
    // link, and moves the new pointer *inside* the old version directory —
    // leaving `current` pointing at the version that was replaced.
    const root = tempDir('mango-swap-race-');
    mkdirSync(join(root, '0.1.0'));
    mkdirSync(join(root, '0.2.0'));
    fixtureSymlink('0.1.0', join(root, 'current'));

    const result = sourceAndCall('rm() { :; }; swap_current "$1" 0.2.0', [root]);

    expect(result.exitCode).toBe(0);
    expect(readlinkSync(join(root, 'current'))).toBe('0.2.0');
    expect(readdirSync(join(root, '0.1.0'))).toEqual([]);
  });

  test('parse_manifest_field reads a top-level string field without matching nested keys', () => {
    const workDir = tempDir('mango-manifest-');
    const manifestPath = join(workDir, 'canary-manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: '0.1.1-canary.abc1234',
          sourceSha: 'abc1234',
          pairs: [{ hub: { asset: 'not-version', digest: 'x' } }],
        },
        null,
        2
      )
    );

    const version = sourceAndCall('parse_manifest_field "$1" version', [manifestPath]);
    const sourceSha = sourceAndCall('parse_manifest_field "$1" sourceSha', [manifestPath]);

    expect(version.stdout.trim()).toBe('0.1.1-canary.abc1234');
    expect(sourceSha.stdout.trim()).toBe('abc1234');
  });
});

// macOS ships /bin/bash 3.2.57, and both `curl | bash` and the hub's own
// ['bash', script] spawn run this script under whatever bash is on PATH — so
// it has to work on 3.2, not just the bash 4/5 this host and CI normally run.
// The image is Alpine/musl (no curl, busybox tar/sed/grep), so only the
// `--local`/`--use`/`--rollback`/`--prune` paths are exercised here; that
// matches every case that can run without a network fetch.
const DOCKER = Bun.which('docker');
const BASH32_IMAGE = 'docker.io/library/bash:3.2';
const HAS_UID = typeof process.getuid === 'function' && typeof process.getgid === 'function';

function dockerUnavailableReason(): string {
  if (!DOCKER) return 'docker is not on PATH';
  if (!HAS_UID) return 'process.getuid/getgid are unavailable on this platform';
  const check = Bun.spawnSync({ cmd: [DOCKER, 'info'] });
  if (check.exitCode !== 0) return 'docker daemon is not reachable';
  // Pull up front: a first `docker run` otherwise pulls inline, and its
  // progress lands on the stderr the cases below assert is empty.
  const pull = Bun.spawnSync({ cmd: [DOCKER, 'pull', '--quiet', BASH32_IMAGE] });
  if (pull.exitCode !== 0) {
    return `could not pull ${BASH32_IMAGE}: ${pull.stderr.toString().trim()}`;
  }
  return '';
}

const DOCKER_SKIP_REASON = dockerUnavailableReason();

interface Bash32Layout extends Layout {
  readonly scriptPathInContainer: string;
}

/** Same layout as the host-bash suite, plus install.sh copied into the mounted workDir. */
function bash32Layout(): Bash32Layout {
  const l = layout();
  const scriptPath = join(l.workDir, 'install.sh');
  writeFileSync(scriptPath, readFileSync(INSTALL_SH, 'utf8'));
  chmodSync(scriptPath, 0o755);
  return { ...l, scriptPathInContainer: '/w/install.sh' };
}

/** `<workDir host path> → /w` inside the container; every fixture path under workDir needs the same rewrite. */
function toContainerPath(l: Bash32Layout, hostPath: string): string {
  return hostPath.replace(l.workDir, '/w');
}

/** Runs an arbitrary bash -c script inside the container, with install.sh's functions (cleanup_tmp_dir, etc.) sourced in first. */
function runInBash32(l: Bash32Layout, script: string): RunResult {
  const result = Bun.spawnSync({
    cmd: [
      DOCKER as string,
      'run',
      '--rm',
      '--user',
      `${process.getuid?.()}:${process.getgid?.()}`,
      '-v',
      `${l.workDir}:/w`,
      BASH32_IMAGE,
      '-c',
      `source "${l.scriptPathInContainer}"; ${script}`,
    ],
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runBash32(l: Bash32Layout, args: string[], env: Record<string, string>): RunResult {
  const containerEnv = {
    ...env,
    // `--user <uid>` names a user the image has no passwd entry for, so give
    // the script an explicit HOME rather than whatever the runtime defaults to.
    HOME: '/w',
    MANGOSTUDIO_INSTALL_DIR: '/w/root',
    MANGOSTUDIO_BIN_DIR: '/w/bin',
  };
  const envArgs = Object.entries(containerEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const result = Bun.spawnSync({
    cmd: [
      DOCKER as string,
      'run',
      '--rm',
      '--user',
      `${process.getuid?.()}:${process.getgid?.()}`,
      '-v',
      `${l.workDir}:/w`,
      ...envArgs,
      BASH32_IMAGE,
      l.scriptPathInContainer,
      ...args.map((arg) => toContainerPath(l, arg)),
    ],
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe('install.sh under bash 3.2 (docker)', () => {
  test.skipIf(!DOCKER_SKIP_REASON)(`skipped: ${DOCKER_SKIP_REASON}`, () => {
    // Body intentionally empty: this entry exists only to name the skip reason.
  });

  test.skipIf(!!DOCKER_SKIP_REASON)(
    'a fresh install and a repair reinstall both exit 0 and write install-origin.json',
    () => {
      // Reproduces the P1: on bash < 4.4, iterating the empty
      // ORIGIN_EXTRA_LINES array under `set -u` was "unbound variable" on
      // *every* write_origin_record call — including a plain first install —
      // and the EXIT trap swallowed that failure's exit status, so the
      // script still reported success with current moved and no origin file.
      const l = bash32Layout();
      const archive = buildReleaseArchive(l.workDir, 'mangostudio-0.1.0-linux-x64.tar.gz', '0.1.0');

      const first = runBash32(l, ['--local', archive, '--version', '0.1.0'], {});
      expect({ exitCode: first.exitCode, stderr: first.stderr }).toEqual({
        exitCode: 0,
        stderr: '',
      });
      expect(existsSync(join(l.root, 'install-origin.json'))).toBe(true);
      expect(originRecord(l.root)).toMatchObject({ version: '0.1.0' });

      // A second install of the same archive/version exercises the
      // `[ -f "$file" ]` branch in record_origin (readarray on an existing
      // file), the other call site the same bug lived in.
      const second = runBash32(l, ['--local', archive, '--version', '0.1.0'], {});
      expect(second.stderr).toBe('');
      expect(second.exitCode).toBe(0);
      expect(originRecord(l.root)).toMatchObject({ version: '0.1.0' });
    }
  );

  // extract_archive's own `fail 'archive is missing mangostudio'` calls
  // `exit 1` directly; bash preserves an explicit `exit N` through an EXIT
  // trap regardless of the trap's own last command (verified directly
  // against this image: `trap 'true' EXIT; exit 1` and `trap 'false' EXIT;
  // exit 1` both still exit 1) — so this case was never actually at risk of
  // the "trap swallows the status" defect. It pins the ordinary failure path
  // instead: non-zero exit, and no install-origin.json.
  test.skipIf(!!DOCKER_SKIP_REASON)('a forced mid-script failure exits non-zero, not 0', () => {
    const l = bash32Layout();
    const bad = buildArchiveMissingBinary(l.workDir, 'mangostudio-9.9.9-bad.tar.gz');

    const result = runBash32(l, ['--local', bad, '--version', '9.9.9'], {});

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('archive is missing mangostudio');
    expect(existsSync(join(l.root, 'install-origin.json'))).toBe(false);
  });

  test.skipIf(!!DOCKER_SKIP_REASON)(
    'a set -u abort does not carry a meaningful $? into the EXIT trap, with or without the trap fix',
    () => {
      // Documents a nuance worth pinning: a `set -u`/nounset fatal abort
      // never calls `exit N`, so there is no
      // pending exit status for the trap to protect — capturing $? at trap
      // entry (`rc=$?`) still only sees whatever the *last successful*
      // command left behind (0 here), not "the abort". Both the old and the
      // fixed trap give exit 0 in this isolated case; what actually turns
      // the real bug's "exits 0" into "exits non-zero" is eliminating the
      // abort itself (the empty-array guards above), not the trap's shape.
      // This test exists so a future change to cleanup_tmp_dir does not
      // reintroduce a claim this bash version does not support.
      const l = bash32Layout();
      const abort = 'set -u; : "$NOPE"';

      const oldTrap = runInBash32(
        l,
        `TMP_DIR="$(mktemp -d)"; trap 'rm -rf "$TMP_DIR"' EXIT; ${abort}`
      );
      const newTrap = runInBash32(l, `TMP_DIR="$(mktemp -d)"; trap cleanup_tmp_dir EXIT; ${abort}`);

      expect(oldTrap.exitCode).toBe(0);
      expect(newTrap.exitCode).toBe(0);
    }
  );
});
