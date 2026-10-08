import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { FIXTURE_DIR_PREFIX, pruneFixtureUserPath } from './support/windows-user-path';

// Same matrix as install-sh-layout.unit.test.ts, run against the real host
// PowerShell (powershell.exe on PATH via WSL interop) instead of bash.
//
// Two gates, because install.ps1's smoke check actually executes
// mangostudio.exe:
//  - POWERSHELL: powershell.exe must be reachable at all.
//  - WINDOWS_BINARY: a real windows-x64 mangostudio.exe, needed by every case
//    that goes through an install (fresh install, --use, --rollback, legacy
//    migration, the npm tarball, the smoke mismatch). Produce one locally
//    with `VERSION=0.1.0 bun run build --binary --platform windows-x64` and
//    point MANGOSTUDIO_TEST_WINDOWS_BINARY at
//    .mango/out/windows-x64/mangostudio.exe to run those cases.
// Cases that never smoke an exe (prune bookkeeping, unknown-line survival,
// uninstall, the --rollback/--use failure paths) hand-craft the on-disk
// layout directly and only need POWERSHELL, with a dummy mangostudio.exe.
//
// The "failed version probe" and "npm tarball extraction" cases need only
// POWERSHELL too: their fake exes are copies of System32 binaries, built in
// the test, or compiled by the host's own Windows PowerShell. They also run
// natively on Windows (the path helpers below are the identity there), which
// is how the release dry run's Windows job runs them: that is the only CI job
// with a Windows PowerShell.

const INSTALL_PS1 = join(import.meta.dir, '..', 'install', 'install.ps1');
const POWERSHELL = Bun.which('powershell.exe');
const WINDOWS_BINARY = process.env.MANGOSTUDIO_TEST_WINDOWS_BINARY;
const IS_WINDOWS = process.platform === 'win32';

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function sh(cmd: string[]): RunResult {
  const result = Bun.spawnSync({ cmd });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function toWindowsPath(linuxPath: string): string {
  if (IS_WINDOWS) return linuxPath;
  const result = sh(['wslpath', '-w', linuxPath]);
  if (result.exitCode !== 0)
    throw new Error(`wslpath -w failed for ${linuxPath}: ${result.stderr}`);
  return result.stdout.trim();
}

function toLinuxPath(windowsPath: string): string {
  if (IS_WINDOWS) return windowsPath;
  const result = sh(['wslpath', windowsPath]);
  if (result.exitCode !== 0) throw new Error(`wslpath failed for ${windowsPath}: ${result.stderr}`);
  return result.stdout.trim();
}

let windowsTempMount = '';
let tempDirs: string[] = [];

beforeAll(() => {
  if (!POWERSHELL) return;
  if (IS_WINDOWS) {
    windowsTempMount = tmpdir();
    return;
  }
  // A path under %TEMP% is one the Windows-side PowerShell can address
  // directly as C:\...; a \\wsl.localhost\... UNC path (what wslpath -w
  // would produce for a repo path) breaks junction creation and .cmd
  // execution, so every fixture lives here instead.
  const temp = sh([POWERSHELL, '-NoProfile', '-Command', '$env:TEMP']);
  windowsTempMount = toLinuxPath(temp.stdout.replace(/\r/g, '').trim());
});

// Fresh installs, -Use, and -Rollback all call Add-UserPath, which writes
// the fixture's bin dir into the real HKCU\Environment\Path — a machine-wide
// side effect that outlives the temp dir it points at. -Uninstall reverses
// it, but not every case in this matrix uninstalls (prune bookkeeping,
// unknown-line survival, the failure paths), so sweep by the mkdtemp prefix
// unconditionally rather than tracking which layouts actually ran a path
// mutation. The sweep reads the PATH after every case but writes it (about
// 7 s, a settings broadcast) only when an entry carries that prefix, and a
// failed write fails the case; see support/windows-user-path.ts.
function pruneStalePathEntries(): void {
  pruneFixtureUserPath(POWERSHELL as string);
}

afterEach(() => {
  // A killed powershell.exe can leave a lock on a file it briefly opened, and
  // failing cleanup here would otherwise replace the test's real failure with
  // an unrelated EACCES/EIO — so cleanup failures are best-effort.
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { force: true, recursive: true });
    } catch {
      // best-effort
    }
  }
  tempDirs = [];

  if (POWERSHELL) pruneStalePathEntries();
});

interface Layout {
  readonly linuxDir: string;
  readonly rootLinux: string;
  readonly binLinux: string;
  readonly root: string;
  readonly bin: string;
  readonly scriptPath: string;
  readonly env: Record<string, string>;
}

function layout(): Layout {
  const linuxDir = mkdtempSync(join(windowsTempMount, FIXTURE_DIR_PREFIX));
  tempDirs.push(linuxDir);
  const windowsDir = toWindowsPath(linuxDir);

  const scriptLinuxPath = join(linuxDir, 'install.ps1');
  writeFileSync(scriptLinuxPath, readFileSync(INSTALL_PS1, 'utf8'));

  const rootLinux = join(linuxDir, 'root');
  const binLinux = join(linuxDir, 'bin');

  return {
    linuxDir,
    rootLinux,
    binLinux,
    root: `${windowsDir}\\root`,
    bin: `${windowsDir}\\bin`,
    scriptPath: `${windowsDir}\\install.ps1`,
    env: {
      MANGOSTUDIO_INSTALL_DIR: `${windowsDir}\\root`,
      MANGOSTUDIO_BIN_DIR: `${windowsDir}\\bin`,
    },
  };
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// A flag name (-Use, -Prune, ...) must stay an unquoted bareword: PowerShell's
// parameter binder only recognises "-Name" as a parameter switch at parse
// time, before quoting is resolved. A quoted '-Use' is just a string value,
// so it silently falls through to positional binding instead of setting $Use.
function psArg(value: string): string {
  return /^-[A-Za-z]/.test(value) ? value : psQuote(value);
}

function run(scriptPath: string, args: string[], env: Record<string, string>): RunResult {
  const assignments = Object.entries(env)
    .map(([key, value]) => `$env:${key} = ${psQuote(value)}`)
    .join('; ');
  const argString = args.map(psArg).join(' ');
  const command =
    `${assignments ? `${assignments}; ` : ''}& ${psQuote(scriptPath)} ${argString}`.trim();
  return sh([
    POWERSHELL as string,
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ]);
}

function readCmd(binLinux: string): string {
  return readFileSync(join(binLinux, 'mangostudio.cmd'), 'utf8');
}

function originRecord(rootLinux: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(rootLinux, 'install-origin.json'), 'utf8'));
}

// PowerShell (the process actually reading these) needs a C:\... path, not
// the /mnt/c/... one node:fs used to create the fixture.
function buildReleaseZip(linuxDir: string, name: string): string {
  const stageDir = join(linuxDir, `stage-${name}`);
  mkdirSync(stageDir, { recursive: true });
  copyFileSync(WINDOWS_BINARY as string, join(stageDir, 'mangostudio.exe'));
  const zipPath = join(linuxDir, name);
  const result = sh(['zip', '-jq', zipPath, join(stageDir, 'mangostudio.exe')]);
  if (result.exitCode !== 0) throw new Error(`zip failed: ${result.stderr}`);
  return toWindowsPath(zipPath);
}

/** A zip with no mangostudio.exe at all — Expand-InstallArchive must Fail() on it, with no real exe needed. */
function buildZipMissingExe(linuxDir: string, name: string): string {
  const stageDir = join(linuxDir, `stage-bad-${name}`);
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(join(stageDir, 'not-mangostudio.txt'), 'not a binary');
  const zipPath = join(linuxDir, name);
  const result = sh(['zip', '-jq', zipPath, join(stageDir, 'not-mangostudio.txt')]);
  if (result.exitCode !== 0) throw new Error(`zip failed: ${result.stderr}`);
  return toWindowsPath(zipPath);
}

/** A System32 binary, at the path this process can read and copy it from. */
function systemExecutable(name: string): string {
  const root = sh([POWERSHELL as string, '-NoProfile', '-Command', '$env:SystemRoot']);
  return join(toLinuxPath(root.stdout.replace(/\r/g, '').trim()), 'System32', name);
}

/**
 * The tar that builds a fixture archive. Natively on Windows that is the
 * System32 bsdtar by full path: a GNU tar first on PATH (Git's usr\bin, which
 * is what `shell: bash` gives a hosted runner) cannot open a `C:\` path.
 */
function systemTar(): string {
  return IS_WINDOWS ? systemExecutable('tar.exe') : 'tar';
}

/**
 * An npm platform tarball whose package/mangostudio.exe is written by
 * `makeExe`: the real binary, unless a case needs a placeholder.
 */
function buildNpmTarball(
  linuxDir: string,
  makeExe: (target: string) => void = (target) => copyFileSync(WINDOWS_BINARY as string, target)
): string {
  const srcDir = join(linuxDir, 'npm-src');
  mkdirSync(join(srcDir, 'package'), { recursive: true });
  makeExe(join(srcDir, 'package', 'mangostudio.exe'));
  const tgzPath = join(linuxDir, 'mangostudio-npm.tgz');
  const tar = systemTar();
  const result = sh([tar, '-czf', tgzPath, '-C', srcDir, 'package']);
  if (result.exitCode !== 0) {
    throw new Error(
      `expected ${tar} to create ${tgzPath} | received exit ${result.exitCode}: ${result.stderr}`
    );
  }
  return toWindowsPath(tgzPath);
}

/** The real binary's own reported version, discovered once and reused as "the good version". */
function discoverRealVersion(): string {
  const linuxDir = mkdtempSync(join(windowsTempMount, `${FIXTURE_DIR_PREFIX}probe-`));
  tempDirs.push(linuxDir);
  const exePath = join(linuxDir, 'mangostudio.exe');
  copyFileSync(WINDOWS_BINARY as string, exePath);
  const windowsExePath = toWindowsPath(exePath);
  const result = sh([
    POWERSHELL as string,
    '-NoProfile',
    '-Command',
    `& ${psQuote(windowsExePath)} '--version'`,
  ]);
  return result.stdout.trim();
}

/** Hand-craft an installed layout without running the script, for cases that never smoke an exe. */
function craftInstalledState(
  layoutValue: Layout,
  version: string,
  options: { previousVersion?: string; extra?: Record<string, unknown> } = {}
): void {
  mkdirSync(join(layoutValue.rootLinux, version), { recursive: true });
  writeFileSync(join(layoutValue.rootLinux, version, 'mangostudio.exe'), 'not a real binary');
  mkdirSync(layoutValue.binLinux, { recursive: true });
  const cmdContent = `@echo off\r\n"${layoutValue.root}\\${version}\\mangostudio.exe" %*\r\n`;
  writeFileSync(join(layoutValue.binLinux, 'mangostudio.cmd'), cmdContent);

  const record: Record<string, unknown> = {
    origin: 'installer',
    channel: 'stable',
    version,
    ...(options.previousVersion ? { previousVersion: options.previousVersion } : {}),
    installedAt: '2026-01-01T00:00:00Z',
    source: 'local-archive',
    binDir: layoutValue.bin,
    ...options.extra,
  };
  writeFileSync(
    join(layoutValue.rootLinux, 'install-origin.json'),
    `${JSON.stringify(record, null, 2)}\n`
  );
}

describe('install.ps1 layout (hand-crafted state, no real exe needed)', () => {
  test.skipIf(!POWERSHELL)(
    '--prune keeps current and previous, removes others, leaves the rest alone',
    () => {
      const l = layout();
      craftInstalledState(l, '0.2.0', { previousVersion: '0.1.0' });
      mkdirSync(join(l.rootLinux, '0.1.0'), { recursive: true });
      mkdirSync(join(l.rootLinux, '0.0.9'), { recursive: true });
      mkdirSync(join(l.rootLinux, 'not-a-version'), { recursive: true });
      writeFileSync(join(l.rootLinux, 'random-file.txt'), 'keep-me');

      const result = run(l.scriptPath, ['-Prune'], l.env);

      expect(result.exitCode).toBe(0);
      expect(sh(['test', '-d', join(l.rootLinux, '0.0.9')]).exitCode).not.toBe(0);
      expect(sh(['test', '-d', join(l.rootLinux, '0.1.0')]).exitCode).toBe(0);
      expect(sh(['test', '-d', join(l.rootLinux, '0.2.0')]).exitCode).toBe(0);
      expect(sh(['test', '-d', join(l.rootLinux, 'not-a-version')]).exitCode).toBe(0);
      expect(sh(['test', '-f', join(l.rootLinux, 'random-file.txt')]).exitCode).toBe(0);
    }
  );

  test.skipIf(!POWERSHELL)(
    'unknown properties in install-origin.json survive a --prune rewrite',
    () => {
      const l = layout();
      craftInstalledState(l, '0.2.0', {
        previousVersion: '0.1.0',
        extra: { futureField: 'keep-me' },
      });
      mkdirSync(join(l.rootLinux, '0.1.0'), { recursive: true });

      const result = run(l.scriptPath, ['-Prune'], l.env);

      expect(result.exitCode).toBe(0);
      expect(originRecord(l.rootLinux).futureField).toBe('keep-me');
      expect(originRecord(l.rootLinux).version).toBe('0.2.0');
    }
  );

  test.skipIf(!POWERSHELL)('-Rollback fails clearly when there is no previous version', () => {
    const l = layout();
    craftInstalledState(l, '0.1.0');

    const result = run(l.scriptPath, ['-Rollback'], l.env);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('no previous version recorded to roll back to');
  });

  test.skipIf(!POWERSHELL)('-Use fails clearly when the requested version is not installed', () => {
    const l = layout();
    craftInstalledState(l, '0.1.0');

    const result = run(l.scriptPath, ['-Use', '9.9.9'], l.env);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('version 9.9.9 is not installed');
  });

  test.skipIf(!POWERSHELL)('-Uninstall removes the install root and the .cmd shim', () => {
    const l = layout();
    craftInstalledState(l, '0.1.0');

    const result = run(l.scriptPath, ['-Uninstall'], l.env);

    expect(result.exitCode).toBe(0);
    expect(sh(['test', '-e', l.rootLinux]).exitCode).not.toBe(0);
    expect(sh(['test', '-e', join(l.binLinux, 'mangostudio.cmd')]).exitCode).not.toBe(0);
  });

  test.skipIf(!POWERSHELL)(
    '-Uninstall leaves a .cmd shim that points outside the install root alone',
    () => {
      const l = layout();
      craftInstalledState(l, '0.1.0');
      mkdirSync(l.binLinux, { recursive: true });
      writeFileSync(
        join(l.binLinux, 'mangostudio.cmd'),
        `@echo off\r\n"${l.root}\\..\\elsewhere\\mangostudio.exe" %*\r\n`
      );

      run(l.scriptPath, ['-Uninstall'], l.env);

      expect(sh(['test', '-f', join(l.binLinux, 'mangostudio.cmd')]).exitCode).toBe(0);
    }
  );

  test.skipIf(!POWERSHELL)(
    '-Prune and -Uninstall never fail on host architecture detection',
    () => {
      // Get-Platform used to run unconditionally at the top of Invoke-Main;
      // -Prune/-Use/-Rollback/-Uninstall never fetch an archive and so never
      // needed to classify the host, but an unrecognised
      // PROCESSOR_ARCHITECTURE would fail Get-Platform anyway and refuse
      // every one of them.
      const l = layout();
      craftInstalledState(l, '0.2.0', { previousVersion: '0.1.0' });
      const bogusArchEnv = {
        ...l.env,
        PROCESSOR_ARCHITECTURE: 'bogus-arch',
        PROCESSOR_ARCHITEW6432: '',
      };

      const pruneResult = run(l.scriptPath, ['-Prune'], bogusArchEnv);
      expect(pruneResult.exitCode).toBe(0);
      expect(pruneResult.stderr).not.toContain('unsupported architecture');

      const uninstallResult = run(l.scriptPath, ['-Uninstall'], bogusArchEnv);
      expect(uninstallResult.exitCode).toBe(0);
      expect(uninstallResult.stderr).not.toContain('unsupported architecture');
    }
  );

  test.skipIf(!POWERSHELL)(
    '-Prune sweeps leftover .install-*/.staging-*/.rollback-* scratch directories',
    () => {
      // Left behind by an install/upgrade that failed before the swap, or
      // was interrupted mid-flight. None of them match the version-directory
      // pattern the main sweep looks for, so they accumulate forever unless
      // -Prune sweeps them explicitly.
      const l = layout();
      craftInstalledState(l, '0.1.0');
      mkdirSync(join(l.rootLinux, '.install-0.2.0-1234'), { recursive: true });
      mkdirSync(join(l.rootLinux, '.staging-0.2.0-1234'), { recursive: true });
      mkdirSync(join(l.rootLinux, '.rollback-0.0.9-1234'), { recursive: true });

      const result = run(l.scriptPath, ['-Prune'], l.env);

      expect(result.exitCode).toBe(0);
      expect(sh(['test', '-d', join(l.rootLinux, '.install-0.2.0-1234')]).exitCode).not.toBe(0);
      expect(sh(['test', '-d', join(l.rootLinux, '.staging-0.2.0-1234')]).exitCode).not.toBe(0);
      expect(sh(['test', '-d', join(l.rootLinux, '.rollback-0.0.9-1234')]).exitCode).not.toBe(0);
      expect(sh(['test', '-d', join(l.rootLinux, '0.1.0')]).exitCode).toBe(0);
    }
  );

  test.skipIf(!POWERSHELL)(
    'a zip missing mangostudio.exe fails and leaves no .install-* scratch directory behind',
    () => {
      // Fails inside Expand-InstallArchive, before any smoke check — never
      // needs a real, working exe.
      const l = layout();
      const bad = buildZipMissingExe(l.linuxDir, 'mangostudio-9.9.9-windows-x64.zip');

      const result = run(l.scriptPath, ['-Local', bad], l.env);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('missing mangostudio.exe');
      // ls -1 hides dotfiles by default — -A is required, or a leftover
      // `.install-*` directory (always a dotfile) silently passes either way.
      const leftovers = sh([
        'sh',
        '-c',
        `ls -1A "${l.rootLinux}" 2>/dev/null | grep '^\\.install-' || true`,
      ]);
      expect(leftovers.stdout.trim()).toBe('');
    }
  );
});

/**
 * Run `script` with install.ps1 dot-sourced, so a case can call one of its
 * functions without the side effects of a full install (the script guards
 * `Invoke-Main` on `$MyInvocation.InvocationName`).
 */
function runDotSourced(scriptPath: string, script: string): RunResult {
  return sh([
    POWERSHELL as string,
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `. ${psQuote(scriptPath)}; ${script}`,
  ]);
}

describe('install.ps1 shim target', () => {
  // cmd.exe decodes a .cmd in the console's OEM code page, so a path holding a
  // character outside that page cannot survive in the shim body whatever we
  // write it as — host-verified on Windows 11 24H2 at CP850: Oem, ASCII, UTF-8
  // with and without a BOM, and UTF-16 shims all fail to find
  // C:\Users\<CJK>\...\mangostudio.exe. cmd resolves %~dp0 itself, in
  // Unicode, so the target is written relative to the shim instead.
  const roots: readonly (readonly [string, string])[] = [
    ['ascii', 'root'],
    ['cjk', '\u674e\u6e2c\u8a66'],
    ['latin-1 outside ascii', 'Jos\u00e9'],
  ];

  for (const [label, leaf] of roots) {
    test.skipIf(!POWERSHELL)(`writes an ascii-only shim under a ${label} install root`, () => {
      const l = layout();
      const version = '0.1.1-canary.abc1234';
      const root = `${toWindowsPath(l.linuxDir)}\\${leaf}`;
      const bin = `${root}\\bin`;
      const result = runDotSourced(
        l.scriptPath,
        [
          `New-Item -ItemType Directory -Force (Join-Path ${psQuote(root)} '${version}') | Out-Null`,
          `$shim = Write-Shim ${psQuote(root)} '${version}' ${psQuote(bin)}`,
          '$bytes = [System.IO.File]::ReadAllBytes($shim)',
          // @(...) because install.ps1 sets StrictMode: an all-ascii shim makes
          // Where-Object return $null, which has no .Count.
          "Write-Output ('ascii=' + (@($bytes | Where-Object { $_ -gt 127 }).Count -eq 0))",
          `Write-Output ('body=' + ((Get-Content -Raw -Encoding Oem $shim) -replace "\`r?\`n", ' '))`,
          `Write-Output ('version=' + (Get-CurrentVersionFromCmd ${psQuote(root)} $shim))`,
        ].join('; ')
      );

      expect(result.exitCode).toBe(0);
      // Not just "no ? placeholders": every byte in the file is ascii, so no
      // console code page can mangle the path cmd.exe has to resolve.
      expect(result.stdout).toContain('ascii=True');
      expect(result.stdout).toContain(`body=@echo off "%~dp0..\\${version}\\mangostudio.exe" %*`);
      // The shim is still the single source of truth for "what is current".
      expect(result.stdout).toContain(`version=${version}`);
    });
  }

  test.skipIf(!POWERSHELL)('keeps the absolute path when the bin dir has no relative form', () => {
    // A MANGOSTUDIO_BIN_DIR on another drive cannot be expressed relative to
    // the install root; that install keeps exactly the shim it had before.
    const l = layout();
    const root = `${toWindowsPath(l.linuxDir)}\\root`;
    const result = runDotSourced(
      l.scriptPath,
      `Write-Output ('target=' + (Get-ShimTarget 'Z:\\tools\\bin' (Join-Path ${psQuote(root)} '0.1.0\\mangostudio.exe')))`
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`target=${root}\\0.1.0\\mangostudio.exe`);
  });

  test.skipIf(!POWERSHELL)('still reads a version out of an absolute legacy shim', () => {
    // Every install made before this change has an absolute shim; the reader
    // must keep recognising one or an upgrade loses its current version.
    const l = layout();
    craftInstalledState(l, '0.1.0');
    const result = runDotSourced(
      l.scriptPath,
      `Write-Output ('version=' + (Get-CurrentVersionFromCmd ${psQuote(l.root)} ${psQuote(`${l.bin}\\mangostudio.cmd`)}))`
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('version=0.1.0');
  });

  test.skipIf(!POWERSHELL)('-Uninstall removes a shim written in the relative form', () => {
    const l = layout();
    craftInstalledState(l, '0.1.0');
    // The relative shape Write-Shim now produces, pointing at the same place.
    writeFileSync(
      join(l.binLinux, 'mangostudio.cmd'),
      '@echo off\r\n"%~dp0..\\root\\0.1.0\\mangostudio.exe" %*\r\n'
    );

    const result = run(l.scriptPath, ['-Uninstall'], l.env);

    expect(result.exitCode).toBe(0);
    expect(sh(['test', '-e', join(l.binLinux, 'mangostudio.cmd')]).exitCode).not.toBe(0);
  });

  test.skipIf(!POWERSHELL)(
    '-Uninstall leaves a relative shim that resolves outside the install root alone',
    () => {
      const l = layout();
      craftInstalledState(l, '0.1.0');
      writeFileSync(
        join(l.binLinux, 'mangostudio.cmd'),
        '@echo off\r\n"%~dp0..\\elsewhere\\0.1.0\\mangostudio.exe" %*\r\n'
      );

      run(l.scriptPath, ['-Uninstall'], l.env);

      expect(sh(['test', '-f', join(l.binLinux, 'mangostudio.cmd')]).exitCode).toBe(0);
    }
  );
});

describe('install.ps1 current junction', () => {
  // Not a browsing shortcut: hub-executable.ts resolves a restart and a
  // service unit through <root>\\current\\mangostudio.exe, so a pointer that
  // is missing or left on the old version silently re-execs the build the
  // install just replaced.
  function seedVersions(l: Layout, versions: readonly string[]): void {
    mkdirSync(l.rootLinux, { recursive: true });
    for (const version of versions) {
      mkdirSync(join(l.rootLinux, version), { recursive: true });
      writeFileSync(join(l.rootLinux, version, 'keep.txt'), version);
    }
  }

  test.skipIf(!POWERSHELL)('moves the pointer without touching either version', () => {
    const l = layout();
    seedVersions(l, ['0.1.0', '0.2.0']);

    const result = runDotSourced(
      l.scriptPath,
      [
        `Set-CurrentJunction ${psQuote(l.root)} '0.1.0'`,
        `Set-CurrentJunction ${psQuote(l.root)} '0.2.0'`,
        `$cur = Get-Item (Join-Path ${psQuote(l.root)} 'current') -Force`,
        "Write-Output ('linkType=' + $cur.LinkType)",
        `Write-Output ('reads=' + (Get-Content -Raw (Join-Path ${psQuote(l.root)} 'current\\keep.txt')).Trim())`,
      ].join('; ')
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('linkType=Junction');
    expect(result.stdout).toContain('reads=0.2.0');
    // Rename-Item moves the reparse point; the old target keeps its contents.
    expect(readFileSync(join(l.rootLinux, '0.1.0', 'keep.txt'), 'utf8')).toBe('0.1.0');
    expect(readFileSync(join(l.rootLinux, '0.2.0', 'keep.txt'), 'utf8')).toBe('0.2.0');
  });

  test.skipIf(!POWERSHELL)('leaves no staging junction behind', () => {
    const l = layout();
    seedVersions(l, ['0.1.0']);

    const result = runDotSourced(l.scriptPath, `Set-CurrentJunction ${psQuote(l.root)} '0.1.0'`);

    expect(result.exitCode).toBe(0);
    const leftovers = sh(['sh', '-c', `ls -1A "${l.rootLinux}" | grep '^\\.current' || true`]);
    expect(leftovers.stdout.trim()).toBe('');
  });

  test.skipIf(!POWERSHELL)('fails the install when the pointer cannot be replaced', () => {
    // A plain file squatting at <root>\\current: the swap must stop here
    // rather than report success with the pointer still on the old version.
    const l = layout();
    seedVersions(l, ['0.1.0']);
    writeFileSync(join(l.rootLinux, 'current'), 'not a junction');

    const result = runDotSourced(l.scriptPath, `Set-CurrentJunction ${psQuote(l.root)} '0.1.0'`);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('cannot point');
    expect(result.stderr).toContain('current at 0.1.0');
    expect(readFileSync(join(l.rootLinux, 'current'), 'utf8')).toBe('not a junction');
  });

  test.skipIf(!POWERSHELL)('-Prune unlinks an orphaned staging junction', () => {
    // Set-CurrentJunction killed between the create and the rename leaves
    // .current.<pid> behind. It is a reparse point, so the scratch sweep's
    // Remove-Item -Recurse would follow it and delete the version it points
    // at — the whole reason Remove-Junction exists.
    const l = layout();
    craftInstalledState(l, '0.1.0');
    writeFileSync(join(l.rootLinux, '0.1.0', 'keep.txt'), 'survives');
    const staged = runDotSourced(
      l.scriptPath,
      `New-Item -ItemType Junction -Path (Join-Path ${psQuote(l.root)} '.current.1234') -Target (Join-Path ${psQuote(l.root)} '0.1.0') | Out-Null`
    );
    expect(staged.exitCode).toBe(0);

    const result = run(l.scriptPath, ['-Prune'], l.env);

    expect(result.exitCode).toBe(0);
    expect(sh(['test', '-e', join(l.rootLinux, '.current.1234')]).exitCode).not.toBe(0);
    expect(readFileSync(join(l.rootLinux, '0.1.0', 'keep.txt'), 'utf8')).toBe('survives');
  });

  test.skipIf(!POWERSHELL)('points at the new version before the shim is written', () => {
    // Ordering, not decoration: if the shim moved first, a junction failure
    // would leave the shim on the new version and the pointer on the old one.
    const script = readFileSync(INSTALL_PS1, 'utf8');
    const junction = script.indexOf('Set-CurrentJunction $InstallRoot $InstallVersion');
    const shim = script.indexOf('$shimPath = Write-Shim $InstallRoot $InstallVersion $BinDir');
    const useJunction = script.indexOf('Set-CurrentJunction $InstallRoot $requested');
    const useShim = script.indexOf('Write-Shim $InstallRoot $requested $BinDir');

    expect(junction).toBeGreaterThan(0);
    expect(junction).toBeLessThan(shim);
    expect(useJunction).toBeGreaterThan(0);
    expect(useJunction).toBeLessThan(useShim);
  });
});

describe('install.ps1 layout (real windows-x64 exe required)', () => {
  // Every case below is individually gated with test.skipIf(!POWERSHELL ||
  // !WINDOWS_BINARY); this one surfaces *why* they're skipped as a named,
  // always-visible entry instead of leaving that only in the file header.
  const reason = !POWERSHELL
    ? 'powershell.exe is not on PATH'
    : !WINDOWS_BINARY
      ? 'MANGOSTUDIO_TEST_WINDOWS_BINARY is not set; build one with `VERSION=0.1.0 bun run build --binary --platform windows-x64`'
      : '';
  test.skipIf(!reason)(`skipped: ${reason}`, () => {
    // Body intentionally empty: this entry exists only to name the skip reason.
  });

  let goodVersion = '';
  beforeAll(() => {
    if (POWERSHELL && WINDOWS_BINARY) {
      goodVersion = discoverRealVersion();
    }
  }, 30000);

  test.skipIf(!POWERSHELL || !WINDOWS_BINARY)(
    'current is a junction to <version>, and the .cmd shim points at that version',
    () => {
      const l = layout();
      const archive = buildReleaseZip(l.linuxDir, `mangostudio-${goodVersion}-windows-x64.zip`);

      const result = run(l.scriptPath, ['-Local', archive], l.env);

      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(readCmd(l.binLinux)).toContain(`\\${goodVersion}\\mangostudio.exe`);
    },
    90000
  );

  test.skipIf(!POWERSHELL || !WINDOWS_BINARY)(
    'writes install-origin.json with the documented shape',
    () => {
      const l = layout();
      const archive = buildReleaseZip(l.linuxDir, `mangostudio-${goodVersion}-windows-x64.zip`);

      run(l.scriptPath, ['-Local', archive], l.env);
      const record = originRecord(l.rootLinux);

      expect(record).toMatchObject({
        origin: 'installer',
        channel: 'stable',
        version: goodVersion,
        source: 'local-archive',
      });
      expect(record.previousVersion).toBeUndefined();
      expect(typeof record.installedAt).toBe('string');
    },
    90000
  );

  test.skipIf(!POWERSHELL || !WINDOWS_BINARY)(
    'reinstalling the same version (a repair install) carries the existing previousVersion forward',
    () => {
      // Simulates: install 0.0.1 (placeholder); install goodVersion (normal
      // swap, previousVersion becomes 0.0.1); install goodVersion again (a
      // repair install / retried upgrade) — NewVersion == OldVersion this
      // time, so the anchor must not collapse onto goodVersion itself.
      const l = layout();
      craftInstalledState(l, '0.0.1', { previousVersion: '0.0.0' });
      const archive = buildReleaseZip(l.linuxDir, `mangostudio-${goodVersion}-windows-x64.zip`);

      const first = run(l.scriptPath, ['-Local', archive], l.env);
      expect(first.exitCode).toBe(0);
      expect(originRecord(l.rootLinux).previousVersion).toBe('0.0.1');

      const second = run(l.scriptPath, ['-Local', archive], l.env);
      expect(second.exitCode).toBe(0);
      expect(originRecord(l.rootLinux).previousVersion).toBe('0.0.1');
    },
    90000
  );

  test.skipIf(!POWERSHELL || !WINDOWS_BINARY)(
    'MANGOSTUDIO_INSTALL_ORIGIN=upgrade records origin: upgrade',
    () => {
      const l = layout();
      const archive = buildReleaseZip(l.linuxDir, `mangostudio-${goodVersion}-windows-x64.zip`);

      run(l.scriptPath, ['-Local', archive], { ...l.env, MANGOSTUDIO_INSTALL_ORIGIN: 'upgrade' });

      expect(originRecord(l.rootLinux).origin).toBe('upgrade');
    },
    90000
  );

  test.skipIf(!POWERSHELL || !WINDOWS_BINARY)(
    '-Use swaps version and previousVersion without downloading',
    () => {
      const l = layout();
      // Current starts at a placeholder version — -Use only needs the *target*
      // directory's exe to pass the smoke check, so the placeholder can stay a
      // dummy file; only goodVersion needs the real, working exe.
      const otherVersion = '0.0.1';
      craftInstalledState(l, otherVersion);
      mkdirSync(join(l.rootLinux, goodVersion), { recursive: true });
      copyFileSync(WINDOWS_BINARY as string, join(l.rootLinux, goodVersion, 'mangostudio.exe'));

      const result = run(l.scriptPath, ['-Use', goodVersion], l.env);

      expect(result.exitCode).toBe(0);
      expect(readCmd(l.binLinux)).toContain(`\\${goodVersion}\\mangostudio.exe`);
      const record = originRecord(l.rootLinux);
      expect(record.version).toBe(goodVersion);
      expect(record.previousVersion).toBe(otherVersion);
    },
    90000
  );

  test.skipIf(!POWERSHELL || !WINDOWS_BINARY)(
    'migrates a legacy root (a pre-existing .cmd shim, no install-origin.json) on the next install',
    () => {
      const l = layout();
      const legacyVersion = '0.0.9';
      mkdirSync(join(l.rootLinux, legacyVersion), { recursive: true });
      writeFileSync(join(l.rootLinux, legacyVersion, 'mangostudio.exe'), 'not a real binary');
      mkdirSync(l.binLinux, { recursive: true });
      writeFileSync(
        join(l.binLinux, 'mangostudio.cmd'),
        `@echo off\r\n"${l.root}\\${legacyVersion}\\mangostudio.exe" %*\r\n`
      );

      const archive = buildReleaseZip(l.linuxDir, `mangostudio-${goodVersion}-windows-x64.zip`);
      const result = run(l.scriptPath, ['-Local', archive], l.env);

      expect(result.exitCode).toBe(0);
      expect(sh(['test', '-f', join(l.rootLinux, legacyVersion, 'mangostudio.exe')]).exitCode).toBe(
        0
      );
      expect(originRecord(l.rootLinux).previousVersion).toBe(legacyVersion);
    },
    90000
  );

  test.skipIf(!POWERSHELL || !WINDOWS_BINARY)(
    'installs an npm platform tarball given an explicit version',
    () => {
      const l = layout();
      const tarball = buildNpmTarball(l.linuxDir);

      const missingVersion = run(l.scriptPath, ['-Local', tarball], l.env);
      expect(missingVersion.exitCode).not.toBe(0);
      expect(missingVersion.stderr).toContain('-Version');

      const result = run(l.scriptPath, ['-Local', tarball, '-Version', goodVersion], l.env);

      expect(result.exitCode).toBe(0);
      expect(sh(['test', '-f', join(l.rootLinux, goodVersion, 'mangostudio.exe')]).exitCode).toBe(
        0
      );
      expect(originRecord(l.rootLinux).source).toBe('npm-registry');
    },
    90000
  );

  test.skipIf(!POWERSHELL || !WINDOWS_BINARY)(
    'a smoke mismatch fails with the expected/received shape and leaves the pointer untouched',
    () => {
      const l = layout();
      const good = buildReleaseZip(l.linuxDir, `mangostudio-${goodVersion}-windows-x64.zip`);
      run(l.scriptPath, ['-Local', good], l.env);

      const mismatched = buildReleaseZip(l.linuxDir, 'mangostudio-mismatch-windows-x64.zip');
      const result = run(l.scriptPath, ['-Local', mismatched, '-Version', '9.9.9'], l.env);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`expected version: 9.9.9 | received: ${goodVersion}`);
      expect(readCmd(l.binLinux)).toContain(`\\${goodVersion}\\mangostudio.exe`);
      expect(sh(['test', '-d', join(l.rootLinux, '9.9.9')]).exitCode).not.toBe(0);
    },
    90000
  );
});

describe('install.ps1 canary tag selection', () => {
  // Mirrors `extract_canary_tag` in install.sh: canary cuts one release per
  // green commit, GitHub lists newest first, and the frozen pre-2026-09 rolling
  // tag (no sha suffix) must still resolve for an older install.
  const releases = (...tags: readonly string[]) =>
    `@(${tags.map((tag) => `[pscustomobject]@{ tag_name = '${tag}' }`).join(', ')})`;

  const selectFrom = (...tags: readonly string[]) =>
    runDotSourced(
      layout().scriptPath,
      `Write-Output ('tag=' + (Select-CanaryTag ${releases(...tags)}))`
    );

  test.skipIf(!POWERSHELL)('picks the newest per-commit canary tag', () => {
    const result = selectFrom('v0.1.2', 'v0.1.1-canary.abc1234', 'v0.1.1-canary.9876543');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tag=v0.1.1-canary.abc1234');
  });

  test.skipIf(!POWERSHELL)('accepts a git-describe style sha identifier', () => {
    const result = selectFrom('v0.1.1-canary.g0123456');

    expect(result.stdout).toContain('tag=v0.1.1-canary.g0123456');
  });

  test.skipIf(!POWERSHELL)('still resolves the frozen rolling tag', () => {
    const result = selectFrom('v0.1.2', 'v0.1.1-canary');

    expect(result.stdout).toContain('tag=v0.1.1-canary');
  });

  test.skipIf(!POWERSHELL)('selects nothing when no release is canary', () => {
    const result = selectFrom('v0.1.2', 'v0.2.0-rc.1');

    expect(result.stdout).toContain('tag=');
    expect(result.stdout).not.toContain('canary');
  });
});

describe('install.ps1 failed version probe (fake mangostudio.exe)', () => {
  // The probe runs `<dir>\mangostudio.exe --version`; when it fails the
  // installer must say why. Windows reports a binary that cannot load through
  // the OS loader, not through the child's stderr, so what the message can
  // carry differs per failure: an exit code and stderr for a binary that ran, a
  // NTSTATUS exit code for a missing DLL, and only the engine's exception for
  // an image that is not a program at all. The text of a system exe's stderr
  // is localized, so these cases pin the shape of the message, not the words.
  const EXPECTED = '9.9.9';
  const FIRST_LINE = `expected version: ${EXPECTED} | received: <none>`;
  // Signed System32 console exes that reject `--version` on stderr. Their
  // messages come from the OS (FormatMessage), not from a `<name>.exe.mui`
  // beside them: renamed to mangostudio.exe, an exe like whoami.exe loses its
  // message table and says nothing.
  const STDERR_SYSTEM_EXES = ['icacls.exe', 'cacls.exe', 'sort.exe'] as const;
  // The loader's own message box can block a desktop session, and a patched or
  // freshly compiled exe is refused by Smart App Control, so the cases that
  // need one run only where MANGOSTUDIO_TEST_NATIVE_FAKES=1 says it is safe: a
  // hosted runner.
  const NATIVE_FAKES = process.env.MANGOSTUDIO_TEST_NATIVE_FAKES === '1';
  const nativeReason = NATIVE_FAKES
    ? ''
    : 'compiled and patched fake exes run only with MANGOSTUDIO_TEST_NATIVE_FAKES=1 (set by the release dry run)';

  test.skipIf(!nativeReason)(`skipped: ${nativeReason}`, () => {
    // Body intentionally empty: this entry exists only to name the skip reason.
  });

  type FakeLayout = Layout & { readonly fakeDir: string; readonly fakeExe: string };

  /** A layout whose `fake/` directory holds the mangostudio.exe under test. */
  function fakeLayout(makeExe: (target: string) => void): FakeLayout {
    const l = layout();
    const fakeLinux = join(l.linuxDir, 'fake');
    mkdirSync(fakeLinux, { recursive: true });
    const fakeExe = join(fakeLinux, 'mangostudio.exe');
    makeExe(fakeExe);
    return { ...l, fakeDir: toWindowsPath(fakeLinux), fakeExe };
  }

  /** What Test-SmokeOrFail throws for the fake, or '<no failure>' when the probe passes. */
  function probeMessage(l: FakeLayout): string {
    const result = runDotSourced(
      l.scriptPath,
      `$m = '<no failure>'; try { Test-SmokeOrFail ${psQuote(l.fakeDir)} ${psQuote(EXPECTED)} $false } catch { $m = $_.Exception.Message }; [Console]::Out.Write($m)`
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `expected the probe to report a message | received exit ${result.exitCode}: ${result.stderr}`
      );
    }
    return result.stdout.replace(/\r/g, '');
  }

  /** Runs the fake itself, so the test knows the exit code the OS gave without asking the installer. */
  function runFake(target: string): { exitCode: number; stderr: string } {
    const direct = Bun.spawnSync({ cmd: [target, '--version'] });
    return { exitCode: direct.exitCode ?? -1, stderr: direct.stderr.toString() };
  }

  function compileFake(target: string, body: string): void {
    const source = `using System; public static class Fake { public static int Main(string[] args) { ${body} } }`;
    const result = sh([
      POWERSHELL as string,
      '-NoProfile',
      '-Command',
      `Add-Type -TypeDefinition ${psQuote(source)} -OutputAssembly ${psQuote(toWindowsPath(target))} -OutputType ConsoleApplication`,
    ]);
    if (result.exitCode !== 0 || !existsSync(target)) {
      throw new Error(
        `expected a compiled fake exe at ${target} | received exit ${result.exitCode}: ${result.stderr}`
      );
    }
  }

  /** The same exe with the first character of its first imported DLL name changed, so the loader cannot find it. */
  function withMissingImport(source: Buffer): Buffer {
    const out = Buffer.from(source);
    const pe = out.readUInt32LE(0x3c);
    if (out.toString('latin1', pe, pe + 4) !== 'PE\0\0') {
      throw new Error(`expected a PE image | received no PE signature at 0x${pe.toString(16)}`);
    }
    const sections = out.readUInt16LE(pe + 6);
    const optional = pe + 24;
    const sectionTable = optional + out.readUInt16LE(pe + 20);
    const directories = optional + (out.readUInt16LE(optional) === 0x20b ? 112 : 96);
    const importRva = out.readUInt32LE(directories + 8);
    const toOffset = (rva: number): number => {
      for (let i = 0; i < sections; i += 1) {
        const section = sectionTable + i * 40;
        const start = out.readUInt32LE(section + 12);
        const size = Math.max(out.readUInt32LE(section + 8), out.readUInt32LE(section + 16));
        if (rva >= start && rva < start + size) return rva - start + out.readUInt32LE(section + 20);
      }
      throw new Error(`expected an RVA inside a section | received 0x${rva.toString(16)}`);
    };
    const nameOffset = toOffset(out.readUInt32LE(toOffset(importRva) + 12));
    out[nameOffset] = out[nameOffset] === 0x78 ? 0x79 : 0x78;
    return out;
  }

  /** A layout whose mangostudio.exe is the first System32 exe that fails `--version` with stderr. */
  function stderrSystemLayout(): FakeLayout & { readonly direct: ReturnType<typeof runFake> } {
    const seen: string[] = [];
    for (const name of STDERR_SYSTEM_EXES) {
      const l = fakeLayout((target) => copyFileSync(systemExecutable(name), target));
      const direct = runFake(l.fakeExe);
      if (direct.exitCode !== 0 && direct.stderr.trim() !== '') return { ...l, direct };
      seen.push(`${name}: exit ${direct.exitCode}, stderr ${JSON.stringify(direct.stderr)}`);
    }
    throw new Error(
      `expected one System32 exe to fail --version with stderr output | received: ${seen.join('; ')}`
    );
  }

  test.skipIf(!POWERSHELL)(
    'a probe that exits non-zero reports its exit code and its stderr',
    () => {
      const { direct, ...l } = stderrSystemLayout();

      const message = probeMessage(l);

      expect(message.split('\n')[0]).toBe(FIRST_LINE);
      expect(message).toContain(
        `expected: exit code: 0 | received: exit code: ${direct.exitCode} (0x`
      );
      expect(message).toMatch(/\n {2}stderr: \S/);
    },
    90000
  );

  const unloadable: ReadonlyArray<readonly [string, (target: string) => void]> = [
    [
      'a truncated PE image',
      (target) =>
        writeFileSync(target, readFileSync(systemExecutable('where.exe')).subarray(0, 512)),
    ],
    ['a text file', (target) => writeFileSync(target, 'this is not a program')],
    ['an empty file', (target) => writeFileSync(target, '')],
  ];

  for (const [label, makeExe] of unloadable) {
    test.skipIf(!POWERSHELL)(
      `${label} reports why it could not be started, without an exit code`,
      () => {
        const l = fakeLayout(makeExe);

        const message = probeMessage(l);

        expect(message.split('\n')[0]).toBe(FIRST_LINE);
        expect(message).toMatch(
          /\n {2}probe: .*mangostudio\.exe --version \| expected: it starts \| received: \S/
        );
        expect(message).not.toContain('exit code');
        // The engine's script position is noise, not the reason.
        expect(message).not.toContain('char:');
      },
      90000
    );
  }

  test.skipIf(!POWERSHELL || !NATIVE_FAKES)(
    'a binary missing a DLL it imports reports the loader status by name',
    () => {
      const l = fakeLayout((target) =>
        writeFileSync(target, withMissingImport(readFileSync(systemExecutable('where.exe'))))
      );

      const message = probeMessage(l);

      expect(message.split('\n')[0]).toBe(FIRST_LINE);
      expect(message).toContain(
        'received: exit code: -1073741515 (0xC0000135, STATUS_DLL_NOT_FOUND)'
      );
      expect(message).not.toContain('stderr:');
    },
    90000
  );

  test.skipIf(!POWERSHELL || !NATIVE_FAKES)(
    'a probe that floods stderr keeps its first ten lines and its exit code',
    () => {
      const l = fakeLayout((target) =>
        compileFake(
          target,
          'for (int i = 1; i <= 200; i++) Console.Error.WriteLine("flood line " + i); return 4;'
        )
      );

      const message = probeMessage(l);

      expect(message).toContain('received: exit code: 4 (0x00000004)');
      expect(message).toContain('stderr: flood line 1\n          flood line 2\n');
      expect(message).toContain('flood line 10');
      expect(message).not.toContain('flood line 11');
    },
    90000
  );

  test.skipIf(!POWERSHELL || !NATIVE_FAKES)(
    'a probe that exits non-zero in silence reports only its exit code',
    () => {
      const l = fakeLayout((target) => compileFake(target, 'return 5;'));

      const message = probeMessage(l);

      expect(message.split('\n')[0]).toBe(FIRST_LINE);
      expect(message).toContain('received: exit code: 5 (0x00000005)');
      expect(message).not.toContain('stderr:');
    },
    90000
  );

  test.skipIf(!POWERSHELL || !NATIVE_FAKES)(
    'a probe that prints the expected version passes, with or without a stderr warning',
    () => {
      const quiet = fakeLayout((target) =>
        compileFake(target, `Console.WriteLine("${EXPECTED}"); return 0;`)
      );
      const noisy = fakeLayout((target) =>
        compileFake(
          target,
          `Console.Error.WriteLine("a warning"); Console.WriteLine("${EXPECTED}"); return 0;`
        )
      );

      expect(probeMessage(quiet)).toBe('<no failure>');
      expect(probeMessage(noisy)).toBe('<no failure>');
    },
    90000
  );

  test.skipIf(!POWERSHELL)(
    'the full install fails with the probe diagnostic and installs nothing',
    () => {
      const l = layout();
      const staged = join(l.linuxDir, 'stage');
      mkdirSync(staged, { recursive: true });
      writeFileSync(join(staged, 'mangostudio.exe'), 'this is not a program');
      // Compress-Archive, not zip(1): a Windows runner has no zip, and a zip
      // keeps the case off the installer's tar.exe, which a GNU tar earlier on
      // the PATH can shadow.
      const archive = join(l.linuxDir, 'mangostudio-fake.zip');
      const packed = sh([
        POWERSHELL as string,
        '-NoProfile',
        '-Command',
        `Compress-Archive -LiteralPath ${psQuote(toWindowsPath(join(staged, 'mangostudio.exe')))} -DestinationPath ${psQuote(toWindowsPath(archive))}`,
      ]);
      expect(packed.exitCode).toBe(0);
      expect(existsSync(archive)).toBe(true);

      const result = run(
        l.scriptPath,
        ['-Local', toWindowsPath(archive), '-Version', EXPECTED],
        l.env
      );

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(FIRST_LINE);
      expect(result.stderr).toContain('expected: it starts | received:');
      expect(existsSync(join(l.rootLinux, EXPECTED))).toBe(false);
      expect(existsSync(join(l.binLinux, 'mangostudio.cmd'))).toBe(false);
    },
    90000
  );
});

describe('install.ps1 npm tarball extraction', () => {
  // `-Local <file>.tgz` goes through tar.exe with a `C:\` path. GNU tar (Git's
  // usr\bin, which is ahead of System32 on a GitHub-hosted windows-latest
  // runner) reads `C:` as a remote host and fails with "Cannot connect to C:
  // resolve failed"; the bsdtar in System32 does not. The installer must not
  // depend on which one PATH finds first. The archive holds a placeholder
  // mangostudio.exe, so a successful extraction ends at the version probe
  // ("expected: it starts"), which is how this case tells the two apart.
  const EXPECTED = '9.9.9';
  // The first line a failed extraction leaves on stderr. Tar's own reason comes
  // ahead of the installer's: `tar (child): Cannot connect to C: resolve
  // failed` from GNU tar, `tar.exe: Error opening archive: ...` from bsdtar.
  const TAR_FAILURE = /\btar(?:\.exe)?(?: \(child\))?: [^\n]*|tar\.exe failed to extract[^\n]*/i;

  /** The directory of the first GNU tar on PATH, or null: there is none, or this is WSL, whose PATH is not the Windows one. */
  function gnuTarDirectory(): string | null {
    if (!IS_WINDOWS) return null;
    const found = sh(['where.exe', 'tar.exe']).stdout.split(/\r?\n/).filter(Boolean);
    for (const candidate of found) {
      const banner = sh([candidate, '--version']).stdout;
      if (/GNU tar/i.test(banner)) return dirname(candidate);
    }
    return null;
  }

  /** A directory whose tar.exe is where.exe: it rejects tar's arguments, so it stands in for a tar PATH must not pick. */
  function decoyTarDirectory(linuxDir: string): string {
    const decoyDir = join(linuxDir, 'first-on-path');
    mkdirSync(decoyDir, { recursive: true });
    copyFileSync(systemExecutable('where.exe'), join(decoyDir, 'tar.exe'));
    return toWindowsPath(decoyDir);
  }

  /** PATH as the installer's PowerShell inherits it; under WSL that is the Windows one, not this process's. */
  function hostPath(): string {
    if (IS_WINDOWS) return process.env.Path ?? process.env.PATH ?? '';
    const path = sh([POWERSHELL as string, '-NoProfile', '-Command', '$env:Path']);
    return path.stdout.replace(/\r/g, '').trim();
  }

  test.skipIf(!POWERSHELL)(
    'extracts a local .tgz when another tar.exe, like a GNU tar, is first on PATH',
    () => {
      const gnuDir = gnuTarDirectory();
      // The hosted Windows runner is the lane with a real GNU tar; a runner
      // image that loses it would otherwise quietly settle for the decoy.
      if (IS_WINDOWS && process.env.GITHUB_ACTIONS === 'true' && gnuDir === null) {
        throw new Error('expected a GNU tar.exe on the hosted runner PATH | received: none');
      }
      const l = layout();
      const tarball = buildNpmTarball(l.linuxDir, (target) =>
        writeFileSync(target, 'this is not a program')
      );
      // With no GNU tar to borrow (WSL, a Windows host without Git's usr\bin on
      // PATH), a decoy keeps the case from passing on PATH order alone.
      const firstOnPath = gnuDir ?? decoyTarDirectory(l.linuxDir);
      const env = { ...l.env, Path: `${firstOnPath};${hostPath()}` };

      const result = run(l.scriptPath, ['-Local', tarball, '-Version', EXPECTED], env);

      const tarFailure = TAR_FAILURE.exec(result.stderr.replace(/\r/g, ''))?.[0] ?? '<none>';
      expect(
        tarFailure,
        `expected tar.exe to extract the .tgz | received: ${tarFailure} (first on PATH: ${gnuDir ? 'GNU tar' : 'where.exe as tar.exe'} in ${firstOnPath})`
      ).toBe('<none>');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`expected version: ${EXPECTED} | received: <none>`);
    },
    90000
  );

  test.skipIf(!POWERSHELL)(
    'a .tgz tar cannot read fails naming the tar that ran and its exit code, and stages nothing',
    () => {
      const l = layout();
      const archive = join(l.linuxDir, 'corrupt.tgz');
      writeFileSync(archive, 'this is not an archive');
      const windowsArchive = toWindowsPath(archive);
      const windowsTar = toWindowsPath(systemExecutable('tar.exe'));

      // The exception message itself, as probeMessage reads it: rendered on
      // stderr, Windows PowerShell wraps it at the console width.
      const result = runDotSourced(
        l.scriptPath,
        `$m = '<no failure>'; try { Expand-InstallArchive ${psQuote(windowsArchive)} ${psQuote(EXPECTED)} ${psQuote(l.root)} | Out-Null } catch { $m = $_.Exception.Message }; [Console]::Out.Write($m)`
      );

      const message = result.stdout.replace(/\r/g, '');
      const exitCode = /received: exit code: ([1-9]\d*)$/.exec(message)?.[1] ?? '<non-zero>';
      expect(message).toBe(
        `${windowsTar} failed to extract ${windowsArchive} | expected: exit code: 0 | received: exit code: ${exitCode}`
      );
      // Neither the .install-* directory nor its .npm-staging sibling survives.
      expect(readdirSync(l.rootLinux)).toEqual([]);
    },
    90000
  );
});
