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

/** The environment the shell runs in: the process's, plus `env`, with install paths made POSIX. */
function shellEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const shellEnv = { ...process.env, ...env };
  if (IS_WINDOWS) shellEnv.MSYS = 'winsymlinks:nativestrict';
  for (const key of ['MANGOSTUDIO_INSTALL_DIR', 'MANGOSTUDIO_BIN_DIR', 'TMPDIR']) {
    const value = shellEnv[key];
    if (value) shellEnv[key] = shellPath(value);
  }
  return shellEnv as Record<string, string>;
}

/** Execute the real POSIX shell with real symlinks, e.g. shell(['-c', 'uname -s']). */
function shell(args: string[], env: Record<string, string | undefined> = {}): RunResult {
  const result = Bun.spawnSync({
    cmd: [BASH, ...args],
    env: shellEnvironment(env),
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** The bash arguments that run install.sh with `args`, under the Linux layout fixture on Windows. */
function installerCommand(args: string[]): string[] {
  const command = [shellPath(INSTALL_SH), ...args.map(shellPath)];
  if (!IS_WINDOWS) return command;
  return ['-c', `${FIXTURE_LINUX_UNAME}\nexec "$BASH" "$@"`, 'linux-layout-fixture', ...command];
}

function run(args: string[], env: Record<string, string | undefined>): RunResult {
  return shell(installerCommand(args), env);
}

/**
 * Start install.sh without waiting for it, e.g. to run it while a lock is held. `detached` makes
 * it a process group leader, so a test can signal the whole group as a terminal's Ctrl-C does.
 */
function runInBackground(
  args: string[],
  env: Record<string, string | undefined>,
  detached = false
) {
  return Bun.spawn({
    cmd: [BASH, ...installerCommand(args)],
    env: shellEnvironment(env),
    stdout: 'pipe',
    stderr: 'pipe',
    detached,
  });
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
  failure: {
    readonly stderr: string;
    readonly exitCode: number;
    readonly stdout?: string;
  }
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
    env: {
      MANGOSTUDIO_INSTALL_DIR: shellPath(root),
      MANGOSTUDIO_BIN_DIR: shellPath(bin),
    },
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

    run(['--local', archive], {
      ...env,
      MANGOSTUDIO_INSTALL_ORIGIN: 'upgrade',
    });

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

// The Cargo launcher serializes installs of one version on an exclusive advisory lock on
// `<install root>/.launcher-<version>.lock`. install.sh has to take the same lock around the
// version directory swap, or the two replace each other's tree. The holder below is a launcher
// stand-in that shares nothing with install.sh but the lock file: perl's flock(2), as the
// launcher's std::fs::File::try_lock on Unix.
const PERL = Bun.which('perl');

/** The lock file of `version` in `root`, named as the launcher names it. */
function launcherLockPath(root: string, version: string): string {
  return join(root, `.launcher-${version}.lock`);
}

/** Hold the launcher's lock for `version` in `root` until `release()`. */
async function holdLauncherLock(root: string, version: string) {
  mkdirSync(root, { recursive: true });
  const holder = Bun.spawn({
    cmd: [
      PERL as string,
      '-MFcntl=:flock',
      '-e',
      '$| = 1; open(my $file, ">>", $ARGV[0]) or die "open: $!"; flock($file, LOCK_EX) or die "flock: $!"; print "locked\\n"; <STDIN>;',
      launcherLockPath(root, version),
    ],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = holder.stdout.getReader();
  const { value } = await reader.read();
  const announced = new TextDecoder().decode(value);
  if (!announced.includes('locked')) {
    throw new Error(
      `lock holder for ${launcherLockPath(root, version)} | expected: locked | received: ${JSON.stringify(announced)} ${await new Response(holder.stderr).text()}`
    );
  }
  return {
    async release() {
      // One line unblocks the holder's read; it exits and drops the lock.
      await holder.stdin.write('release\n');
      await holder.stdin.end();
      await holder.exited;
    },
  };
}

/**
 * The spellings of `path` a Windows shell may print it in: native (`C:\a\b`), with forward
 * slashes (`C:/a/b`), and as the MSYS path Git Bash uses (`/c/a/b`). Elsewhere only `path` itself.
 */
function pathSpellings(path: string): string[] {
  if (!IS_WINDOWS) return [path];
  const forward = path.replaceAll('\\', '/');
  return [
    path,
    forward,
    forward.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`),
  ];
}

/** Assert `output` names `path`, in any spelling a shell on this platform prints it in. */
function expectNamesPath(output: string, path: string): void {
  const spellings = pathSpellings(path);
  expect(
    spellings.some((spelling) => output.includes(spelling)),
    `expected output to name ${JSON.stringify(path)} (or ${JSON.stringify(spellings.slice(1))}) | received: ${JSON.stringify(output)}`
  ).toBe(true);
}

/** Resolve once `process` has exited, or after `milliseconds`, whichever comes first. */
async function waitForExit(
  process: ReturnType<typeof runInBackground>,
  milliseconds: number
): Promise<void> {
  await Promise.race([process.exited, Bun.sleep(milliseconds)]);
}

/** The `.install-*` scratch trees in `root`. */
function scratchTrees(root: string): string[] {
  return readdirSync(root).filter((entry) => entry.startsWith('.install-'));
}

/** Resolve once `process` has printed `needle` on stdout; fail with what it printed after `milliseconds`. */
async function waitForOutput(
  process: ReturnType<typeof runInBackground>,
  needle: string,
  milliseconds: number
): Promise<void> {
  const reader = process.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + milliseconds;
  let seen = '';
  try {
    while (!seen.includes(needle)) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null),
      ]);
      if (chunk === null || chunk.done) {
        throw new Error(
          `install.sh stdout | expected to contain: ${JSON.stringify(needle)} | received: ${JSON.stringify(seen)}`
        );
      }
      seen += decoder.decode(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
}

describe.skipIf(!PERL)('install.sh version lock', () => {
  /** A root holding 0.1.0 with a marker the next install of 0.1.0 must replace. */
  function installedWithMarker() {
    const l = layout();
    const archive = buildReleaseArchive(l.workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, '0.1.0');
    const first = run(['--local', archive], l.env);
    expect(first.exitCode, JSON.stringify(first)).toBe(0);
    const marker = join(l.root, '0.1.0', 'old-install-marker');
    writeFileSync(marker, 'laid down by the first install');
    return { ...l, archive, marker };
  }

  test('an install waits for the version lock and replaces the tree only once it is released', async () => {
    const { root, env, archive, marker } = installedWithMarker();
    const lock = await holdLauncherLock(root, '0.1.0');
    const installer = runInBackground(['--local', archive], env);
    try {
      await waitForExit(installer, 600);

      expect(
        installer.exitCode,
        `expected install.sh to wait on ${launcherLockPath(root, '0.1.0')} | received exit code: ${installer.exitCode}`
      ).toBeNull();
      expect(existsSync(marker), `expected ${marker} untouched while the lock is held`).toBe(true);
    } finally {
      await lock.release();
    }

    expect(await installer.exited, await new Response(installer.stderr).text()).toBe(0);
    expect(existsSync(marker), `expected ${marker} replaced after the lock was released`).toBe(
      false
    );
    expect(readlinkSync(join(root, 'current'))).toBe('0.1.0');
  }, 30000);

  test('an install gives up at the lock timeout, names the lock and leaves the tree and no scratch', async () => {
    const { root, env, archive, marker } = installedWithMarker();
    const lock = await holdLauncherLock(root, '0.1.0');
    try {
      const result = run(['--local', archive], {
        ...env,
        MANGOSTUDIO_INSTALL_LOCK_TIMEOUT: '0.5',
      });

      expect(result.exitCode, JSON.stringify(result)).toBe(1);
      expectNamesPath(result.stderr, launcherLockPath(root, '0.1.0'));
      expect(result.stderr).toContain('still');
      expect(existsSync(marker), `expected ${marker} untouched`).toBe(true);
      expect(readdirSync(root).filter((entry) => entry.startsWith('.install-'))).toEqual([]);
    } finally {
      await lock.release();
    }
  }, 30000);

  // Ctrl-C during the wait (up to an hour) must not leave `.install-<version>.<pid>` behind.
  // SIGINT goes to the whole process group, as a terminal sends it, so the `sleep` child that
  // bash is waiting on dies of it too; a SIGINT sent to bash alone is deferred by bash.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    test.skipIf(IS_WINDOWS)(
      `${signal} during the lock wait removes the scratch tree and keeps the installed one`,
      async () => {
        const { root, env, archive, marker } = installedWithMarker();
        const lock = await holdLauncherLock(root, '0.1.0');
        const installer = runInBackground(['--local', archive], env, true);
        try {
          await waitForOutput(installer, 'Waiting for another installer', 10000);
          const scratchWhileWaiting = scratchTrees(root);
          expect(
            scratchWhileWaiting.length,
            `expected one .install-0.1.0.<pid> tree while waiting on the lock | received: ${JSON.stringify(scratchWhileWaiting)}`
          ).toBe(1);

          process.kill(signal === 'SIGINT' ? -installer.pid : installer.pid, signal);
          const exited = await Promise.race([installer.exited, Bun.sleep(10000).then(() => null)]);

          expect(
            exited,
            `expected install.sh to exit ${signal === 'SIGINT' ? 130 : 143} after ${signal} | received: ${exited ?? 'still running'}`
          ).toBe(signal === 'SIGINT' ? 130 : 143);
          expect(
            scratchTrees(root),
            `expected no .install-* tree in ${root} after ${signal}`
          ).toEqual([]);
          expect(existsSync(marker), `expected ${marker} untouched`).toBe(true);
        } finally {
          installer.kill('SIGKILL');
          await lock.release();
        }
      },
      60000
    );
  }

  // A lock freed mid-wait must be taken within a poll interval, not up to a second later.
  // Released right after the wait notice, the old one-second poll returns ~1000 ms later; the
  // bound is loose enough for a slow Windows shell and far below that.
  test('acquire_version_lock takes a lock freed mid-wait within a fraction of a second', async () => {
    const root = tempDir('mango-lock-poll-');
    const lock = await holdLauncherLock(root, '0.1.0');
    const waiter = Bun.spawn({
      cmd: [
        BASH,
        '-c',
        `${IS_WINDOWS ? FIXTURE_LINUX_UNAME : ''}\nsource "$1"; acquire_version_lock "$2" 0.1.0 && echo acquired`,
        'lock-poll-fixture',
        shellPath(INSTALL_SH),
        shellPath(root),
      ],
      env: shellEnvironment({}),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      await waitForOutput(waiter, 'Waiting for another installer', 10000);
      const releasedAt = performance.now();
      await lock.release();
      const exitCode = await waiter.exited;
      const elapsed = performance.now() - releasedAt;

      expect(exitCode, await new Response(waiter.stderr).text()).toBe(0);
      expect(
        elapsed,
        `expected acquire_version_lock to return within 700 ms of the lock being released | received: ${Math.round(elapsed)} ms`
      ).toBeLessThan(700);
    } finally {
      waiter.kill('SIGKILL');
    }
  }, 30000);

  test('the lock is per version: another version installs while one is held', async () => {
    const { workDir, root, env } = layout();
    const archive = buildReleaseArchive(workDir, `mangostudio-0.2.0-${PLATFORM}.tar.gz`, '0.2.0');
    const lock = await holdLauncherLock(root, '0.1.0');
    try {
      const result = run(['--local', archive], {
        ...env,
        MANGOSTUDIO_INSTALL_LOCK_TIMEOUT: '0.5',
      });

      expect(result.exitCode, JSON.stringify(result)).toBe(0);
      expect(readlinkSync(join(root, 'current'))).toBe('0.2.0');
    } finally {
      await lock.release();
    }
  }, 30000);

  test('--prune leaves a version whose lock is held and removes it on the next run', async () => {
    const { workDir, root, env } = installedWithMarker();
    const second = buildReleaseArchive(workDir, `mangostudio-0.2.0-${PLATFORM}.tar.gz`, '0.2.0');
    expect(run(['--local', second], env).exitCode).toBe(0);
    mkdirSync(join(root, '0.0.9'));
    const lock = await holdLauncherLock(root, '0.0.9');
    try {
      const held = run(['--prune'], {
        ...env,
        MANGOSTUDIO_INSTALL_LOCK_TIMEOUT: '0.3',
      });

      expect(held.exitCode, JSON.stringify(held)).toBe(0);
      expect(held.stdout).toContain('Could not remove 0.0.9');
      expect(existsSync(join(root, '0.0.9'))).toBe(true);
    } finally {
      await lock.release();
    }

    const free = run(['--prune'], env);

    expect(free.exitCode, JSON.stringify(free)).toBe(0);
    expect(existsSync(join(root, '0.0.9'))).toBe(false);
  }, 30000);

  test('the lock file is named like the launcher names it, in the shell and PowerShell installers', () => {
    const launcher = readFileSync(
      join(import.meta.dir, '..', '..', 'crates', 'mangostudio-launcher', 'src', 'main.rs'),
      'utf8'
    );
    const powershell = readFileSync(join(import.meta.dir, '..', 'install', 'install.ps1'), 'utf8');
    const shellInstaller = readFileSync(INSTALL_SH, 'utf8');

    // A boolean, not `toContain`: a failed toContain would print a whole source file.
    const names: ReadonlyArray<readonly [string, string, RegExp]> = [
      ['crates/mangostudio-launcher/src/main.rs', launcher, /"\.launcher-\{version\}\.lock"/],
      ['scripts/install/install.sh', shellInstaller, /\.launcher-\$\{version\}\.lock/],
      ['scripts/install/install.ps1', powershell, /\.launcher-\$Version\.lock/],
    ];
    for (const [file, source, lockName] of names) {
      expect(
        lockName.test(source),
        `${file} | expected the lock file name matching: ${lockName} | received: no such text`
      ).toBe(true);
    }
  });
});

describe('install.sh lock primitive', () => {
  const lockTools = ['flock', 'perl'] as const;

  for (const tool of lockTools) {
    const available = shell(['-c', `command -v ${tool}`]).exitCode === 0;

    test.skipIf(!available || !PERL)(
      `try_lock_fd with only ${tool} takes a free lock and reports a held one`,
      async () => {
        const root = tempDir('mango-lock-');
        const lockFile = launcherLockPath(root, '0.1.0');
        const onlyTool = `have_command() { [ "$1" = ${tool} ] && command -v "$1" >/dev/null 2>&1; }`;
        const attempt = () =>
          sourceAndCall(`${onlyTool}; exec 200>>"$1"; rc=0; try_lock_fd || rc=$?; echo "rc=$rc"`, [
            lockFile,
          ]);
        writeFileSync(lockFile, '');

        const free = attempt();
        const lock = await holdLauncherLock(root, '0.1.0');
        let held: RunResult;
        try {
          held = attempt();
        } finally {
          await lock.release();
        }

        expect(free.stdout.trim(), JSON.stringify(free)).toBe('rc=0');
        expect(held.stdout.trim(), JSON.stringify(held)).toBe('rc=1');
      },
      30000
    );
  }

  // Git Bash holds C:\Users\me as /c/Users/me; a path in a message is for the user to paste into
  // Explorer or PowerShell. A fake cygpath, named for what it does, stands in for the MSYS tool.
  const FAKE_CYGPATH = 'have_command() { [ "$1" = cygpath ]; };';

  // The fake marks its output instead of printing backslashes: a backslash in a script passed as
  // an argument is rewritten on its way through the Windows process boundary.
  test('display_path prints what cygpath -w returns when it converts the path', () => {
    const result = sourceAndCall(
      `${FAKE_CYGPATH} cygpath() { [ "$1" = -w ] && [ "$2" = -- ] && printf 'native(%s)\\n' "$3"; }; display_path /c/Users/me/root`
    );

    expect(result.stdout.trim(), JSON.stringify(result)).toBe('native(/c/Users/me/root)');
  });

  test('display_path prints the path as given when cygpath fails or is absent', () => {
    const failing = sourceAndCall(
      `${FAKE_CYGPATH} cygpath() { return 1; }; display_path /c/Users/me/root`
    );
    const absent = sourceAndCall('have_command() { return 1; }; display_path /c/Users/me/root');

    expect(failing.stdout.trim(), JSON.stringify(failing)).toBe('/c/Users/me/root');
    expect(absent.stdout.trim(), JSON.stringify(absent)).toBe('/c/Users/me/root');
  });

  test('without flock or perl the installer warns that it runs without the lock and goes on', () => {
    const root = tempDir('mango-lock-none-');

    const result = sourceAndCall(
      'have_command() { return 1; }; acquire_version_lock "$1" 0.1.0; echo "rc=$?"',
      [root]
    );

    expect(result.stdout.trim(), JSON.stringify(result)).toBe('rc=0');
    expect(result.stderr).toContain('without the install lock');
  });

  // flock(1) comes in two flavours that disagree about errors. A fake of each, named for what
  // it reports, drives try_lock_fd without either tool installed.
  const FLOCK_FAKES: ReadonlyArray<readonly [string, string, number]> = [
    ['takes a free lock', 'fake_flock() { return 0; }', 0],
    [
      'reports a held lock as exit 1 with no output (util-linux and busybox)',
      'fake_flock() { return 1; }',
      1,
    ],
    [
      'treats exit 1 with a message as unsupported (busybox on a file system without locking)',
      'fake_flock() { echo "flock: Function not implemented" >&2; return 1; }',
      2,
    ],
    [
      'treats another exit code with a message as unsupported (util-linux)',
      'fake_flock() { echo "flock: 200: Bad file descriptor" >&2; return 65; }',
      2,
    ],
  ];
  test.each(FLOCK_FAKES)('try_lock_fd %s', (_name, fake, expected) => {
    const result = sourceAndCall(
      `${fake}; flock() { fake_flock "$@"; }; have_command() { [ "$1" = flock ]; }; rc=0; try_lock_fd || rc=$?; echo "rc=$rc"`
    );

    expect(result.stdout.trim(), JSON.stringify(result)).toBe(`rc=${expected}`);
  });

  test.each([
    { value: '0', ms: 0 },
    { value: '7', ms: 7000 },
    { value: '08', ms: 8000 },
    { value: '123456789', ms: 123456789000 },
    { value: '0.5', ms: 500 },
    { value: '1.25', ms: 1250 },
    { value: '0.001', ms: 1 },
    { value: '0.08', ms: 80 },
    { value: '10s', ms: null },
    { value: '-1', ms: null },
    { value: '+5', ms: null },
    { value: ' 5', ms: null },
    { value: '.5', ms: null },
    { value: '1.', ms: null },
    { value: '1.5.2', ms: null },
    { value: '1.2345', ms: null },
    { value: '1234567890', ms: null },
  ])(
    'MANGOSTUDIO_INSTALL_LOCK_TIMEOUT=$value parses to $ms ms (null: default)',
    ({ value, ms }) => {
      const result = sourceAndCall(
        `INSTALL_LOCK_TIMEOUT='${value}'; validate_install_lock_timeout; echo "timeout=$INSTALL_LOCK_TIMEOUT ms=$INSTALL_LOCK_TIMEOUT_MS"`
      );

      expect(
        result.stdout.trim(),
        `expected ${JSON.stringify(value)} to ${ms === null ? 'fall back to 3600' : `be ${ms} ms`} | received: ${JSON.stringify(result)}`
      ).toBe(ms === null ? 'timeout=3600 ms=3600000' : `timeout=${value} ms=${ms}`);
      expect(
        result.stderr.includes('is not a number of seconds'),
        `expected a warning naming ${JSON.stringify(value)} only when it is rejected | received: ${JSON.stringify(result)}`
      ).toBe(ms === null);
      if (ms === null) expect(result.stderr).toContain(`LOCK_TIMEOUT=${value} is not`);
    }
  );

  test.each([
    { ms: 0, text: '0' },
    { ms: 5000, text: '5' },
    { ms: 600, text: '0.600' },
    { ms: 1250, text: '1.250' },
  ])('lock_seconds_text prints $ms ms as $text', ({ ms, text }) => {
    const result = sourceAndCall(`lock_seconds_text ${ms}`);

    expect(result.stdout, JSON.stringify(result)).toBe(text);
  });

  // sleep stands in for the host's: one that takes fractions, and one (POSIX, some busybox)
  // that refuses anything but whole seconds.
  const FRACTIONAL_SLEEP = 'sleep() { echo "sleep $*"; }';
  const WHOLE_SECOND_SLEEP =
    'sleep() { case "$1" in *[!0-9]*) return 1 ;; esac; echo "sleep $*"; }';

  test.each([
    {
      name: 'a sleep that takes fractions',
      fake: FRACTIONAL_SLEEP,
      poll: 200,
      calls: ['sleep 0.2', 'sleep 0.2'],
    },
    {
      name: 'a sleep that takes whole seconds only',
      fake: WHOLE_SECOND_SLEEP,
      poll: 1000,
      calls: ['sleep 1', 'sleep 1'],
    },
  ])('sleep_between_lock_attempts with $name polls every $poll ms', ({ fake, poll, calls }) => {
    const result = sourceAndCall(
      `${fake}; sleep_between_lock_attempts; sleep_between_lock_attempts; echo "poll=$INSTALL_LOCK_POLL_MS"`
    );

    expect(result.stdout.trim().split('\n'), JSON.stringify(result)).toEqual([
      ...calls,
      `poll=${poll}`,
    ]);
  });

  test('an install with a non-numeric lock timeout warns and installs instead of looping', () => {
    const { workDir, root, env } = layout();
    const archive = buildReleaseArchive(workDir, `mangostudio-0.1.0-${PLATFORM}.tar.gz`, '0.1.0');

    const result = run(['--local', archive], {
      ...env,
      MANGOSTUDIO_INSTALL_LOCK_TIMEOUT: '10s',
    });

    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    expect(result.stderr).toContain(
      'MANGOSTUDIO_INSTALL_LOCK_TIMEOUT=10s is not a number of seconds'
    );
    expect(readlinkSync(join(root, 'current'))).toBe('0.1.0');
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
    {
      name: 'partial response with a tag',
      payload: '[{"tag_name":"v0.1.1-canary.abc1234"}]',
    },
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
    const result = resolveCanaryFromGithub({
      status: 429,
      headers: ['retry-after: 60'],
    });

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
        {
          curlLog: log,
          tokens: { GITHUB_TOKEN: TOKEN, GH_TOKEN: OTHER_TOKEN },
        }
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
      const result = resolveCanaryFromGithub(RATE_LIMITED, {
        tokens: { GH_TOKEN: TOKEN },
      });

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
            seen.push({
              origin: 'target',
              authorization: request.headers.get('authorization'),
            });
            return new Response(CANARY_BODY, {
              headers: { 'content-type': 'application/json' },
            });
          },
        });
        const api = Bun.serve({
          port: 0,
          fetch(request) {
            seen.push({
              origin: 'api',
              authorization: request.headers.get('authorization'),
            });
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
  const pull = Bun.spawnSync({
    cmd: [DOCKER, 'pull', '--quiet', BASH32_IMAGE],
  });
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
