import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INSTALL_SH = join(import.meta.dir, '..', 'install', 'install.sh');

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { force: true, recursive: true });
  tempDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: string[], env: Record<string, string | undefined>): RunResult {
  const result = Bun.spawnSync({
    cmd: ['bash', INSTALL_SH, ...args],
    env: { ...process.env, ...env } as Record<string, string>,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** Call an internal function without running main(), like a unit test of a plain module. */
function sourceAndCall(expression: string): RunResult {
  const result = Bun.spawnSync({
    cmd: ['bash', '-c', `source "$1"; ${expression}`, 'bash', INSTALL_SH],
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

let PLATFORM: string;

beforeAll(() => {
  PLATFORM = sourceAndCall('detect_platform').stdout.trim();
});

function makeFixtureBin(dir: string, printedVersion: string, execPath = 'mangostudio'): void {
  writeFileSync(join(dir, execPath), `#!/bin/sh\necho ${printedVersion}\n`);
  chmodSync(join(dir, execPath), 0o755);
}

/** A release archive shaped like archive-assets.ts produces: mangostudio at the root. */
function buildReleaseArchive(dir: string, name: string, printedVersion: string): string {
  const srcDir = join(dir, `src-${name}`);
  mkdirSync(srcDir, { recursive: true });
  makeFixtureBin(srcDir, printedVersion);
  const archivePath = join(dir, name);
  const result = Bun.spawnSync({ cmd: ['tar', '-czf', archivePath, '-C', srcDir, 'mangostudio'] });
  if (result.exitCode !== 0) throw new Error(`tar failed: ${result.stderr.toString()}`);
  return archivePath;
}

/** An npm platform tarball: members live under package/, per pack-npm.ts. */
function buildNpmTarball(dir: string, printedVersion: string): string {
  const srcDir = join(dir, 'npm-src');
  mkdirSync(join(srcDir, 'package'), { recursive: true });
  makeFixtureBin(join(srcDir, 'package'), printedVersion);
  const archivePath = join(dir, 'mangostudio-npm.tgz');
  const result = Bun.spawnSync({ cmd: ['tar', '-czf', archivePath, '-C', srcDir, 'package'] });
  if (result.exitCode !== 0) throw new Error(`tar failed: ${result.stderr.toString()}`);
  return archivePath;
}

/** A broken archive with no `mangostudio` at all — extract_archive must fail() on it. */
function buildArchiveMissingBinary(dir: string, name: string): string {
  const srcDir = join(dir, `src-bad-${name}`);
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'not-mangostudio'), 'not a binary');
  const archivePath = join(dir, name);
  const result = Bun.spawnSync({
    cmd: ['tar', '-czf', archivePath, '-C', srcDir, 'not-mangostudio'],
  });
  if (result.exitCode !== 0) throw new Error(`tar failed: ${result.stderr.toString()}`);
  return archivePath;
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
    env: { MANGOSTUDIO_INSTALL_DIR: root, MANGOSTUDIO_BIN_DIR: bin },
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
    symlinkSync(join(legacyDir, 'mangostudio'), join(bin, 'mangostudio'));

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
    const stillGood = Bun.spawnSync({ cmd: [join(root, '0.1.0', 'mangostudio'), '--version'] });
    expect(stillGood.stdout.toString().trim()).toBe('0.1.0');
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
    symlinkSync(elsewhere, join(bin, 'mangostudio'));

    run(['--uninstall'], env);

    expect(existsSync(join(bin, 'mangostudio'))).toBe(true);
  });
});

describe('install.sh canary parsing (network-free)', () => {
  test('extract_canary_tag picks the first *-canary tag_name', () => {
    const releasesJson = JSON.stringify([
      { tag_name: 'v0.1.2', prerelease: false },
      { tag_name: 'v0.1.1-canary', prerelease: true },
      { tag_name: 'v0.1.0', prerelease: false },
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

    const version = sourceAndCall(`parse_manifest_field '${manifestPath}' version`);
    const sourceSha = sourceAndCall(`parse_manifest_field '${manifestPath}' sourceSha`);

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
      expect(first.stderr).toBe('');
      expect(first.exitCode).toBe(0);
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
      // Documents a nuance the review's causal story got slightly wrong: a
      // `set -u`/nounset fatal abort never calls `exit N`, so there is no
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
