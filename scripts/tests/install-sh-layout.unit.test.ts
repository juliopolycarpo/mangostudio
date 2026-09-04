import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
