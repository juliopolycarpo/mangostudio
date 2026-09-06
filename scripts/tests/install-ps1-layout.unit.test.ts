import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

const INSTALL_PS1 = join(import.meta.dir, '..', 'install', 'install.ps1');
const POWERSHELL = Bun.which('powershell.exe');
const WINDOWS_BINARY = process.env.MANGOSTUDIO_TEST_WINDOWS_BINARY;

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
  const result = sh(['wslpath', '-w', linuxPath]);
  if (result.exitCode !== 0)
    throw new Error(`wslpath -w failed for ${linuxPath}: ${result.stderr}`);
  return result.stdout.trim();
}

function toLinuxPath(windowsPath: string): string {
  const result = sh(['wslpath', windowsPath]);
  if (result.exitCode !== 0) throw new Error(`wslpath failed for ${windowsPath}: ${result.stderr}`);
  return result.stdout.trim();
}

let windowsTempMount = '';
let tempDirs: string[] = [];

beforeAll(() => {
  if (!POWERSHELL) return;
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
// mutation.
function pruneStalePathEntries(): void {
  const command = [
    "$path = [Environment]::GetEnvironmentVariable('Path','User')",
    "$entries = $path -split ';' | Where-Object { $_ -and $_ -notmatch 'mango-ps1-' }",
    "[Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')",
  ].join('; ');
  sh([POWERSHELL as string, '-NoProfile', '-Command', command]);
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
  const linuxDir = mkdtempSync(join(windowsTempMount, 'mango-ps1-'));
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

function buildNpmTarball(linuxDir: string): string {
  const srcDir = join(linuxDir, 'npm-src');
  mkdirSync(join(srcDir, 'package'), { recursive: true });
  copyFileSync(WINDOWS_BINARY as string, join(srcDir, 'package', 'mangostudio.exe'));
  const tgzPath = join(linuxDir, 'mangostudio-npm.tgz');
  const result = sh(['tar', '-czf', tgzPath, '-C', srcDir, 'package']);
  if (result.exitCode !== 0) throw new Error(`tar failed: ${result.stderr}`);
  return toWindowsPath(tgzPath);
}

/** The real binary's own reported version, discovered once and reused as "the good version". */
function discoverRealVersion(): string {
  const linuxDir = mkdtempSync(join(windowsTempMount, 'mango-ps1-probe-'));
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
