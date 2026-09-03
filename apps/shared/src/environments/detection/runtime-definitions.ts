import { posix, win32 } from 'node:path';
import type { PathEnv } from '../../runtime-env';
import { type RuntimeDefinition, type SemVer, windowsDefaultFnmDir } from './binary-scan';
import { fnmDefaultAliasBinDir, fnmRootCandidates } from './fnm';

function parseSemVer(raw: string, prefix: 'optional-v' | 'none'): SemVer | null {
  const pattern = prefix === 'optional-v' ? /^v?(\d+)\.(\d+)\.(\d+)/ : /^(\d+)\.(\d+)\.(\d+)/;
  const match = raw.trim().match(pattern);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function parseNodeVersion(raw: string): SemVer | null {
  return parseSemVer(raw, 'optional-v');
}

export function parseBunVersion(raw: string): SemVer | null {
  return parseSemVer(raw, 'none');
}

export function wellKnownNodeDirectories(env: PathEnv): string[] {
  if (env.platform === 'win32') {
    const { ProgramFiles, LOCALAPPDATA, NVM_SYMLINK, VOLTA_HOME, FNM_DIR } = env.env;
    const fnmDir = FNM_DIR?.trim() || windowsDefaultFnmDir(env);
    return [
      NVM_SYMLINK,
      ProgramFiles ? win32.join(ProgramFiles, 'nodejs') : undefined,
      env.env['ProgramFiles(x86)']
        ? win32.join(env.env['ProgramFiles(x86)'] as string, 'nodejs')
        : undefined,
      LOCALAPPDATA ? win32.join(LOCALAPPDATA, 'Programs', 'nodejs') : undefined,
      fnmDir ? win32.join(fnmDir, 'aliases', 'default') : undefined,
      VOLTA_HOME ? win32.join(VOLTA_HOME, 'bin') : undefined,
    ].filter((directory): directory is string => Boolean(directory?.trim()));
  }

  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    posix.join(env.homeDir, '.volta', 'bin'),
    ...fnmRootCandidates(env).map((root) => fnmDefaultAliasBinDir(env.platform, root)),
  ];
}

function wellKnownBunDirectories(env: PathEnv): string[] {
  const pathApi = env.platform === 'win32' ? win32 : posix;
  const configuredRoot = env.env.BUN_INSTALL?.trim();
  return [pathApi.join(configuredRoot || pathApi.join(env.homeDir, '.bun'), 'bin')];
}

export const NODE_RUNTIME_DEFINITION: RuntimeDefinition = {
  id: 'node',
  binaryNames: ['node'],
  versionArgs: ['--version'],
  parseVersion: parseNodeVersion,
  wellKnownDirs: wellKnownNodeDirectories,
};

export const BUN_RUNTIME_DEFINITION: RuntimeDefinition = {
  id: 'bun',
  binaryNames: ['bun'],
  versionArgs: ['--version'],
  parseVersion: parseBunVersion,
  wellKnownDirs: wellKnownBunDirectories,
};

/** `raw` is searched rather than anchored: fnm and git prefix their version with their own name. */
function parseSemVerAnywhere(raw: string, pattern: RegExp): SemVer | null {
  const match = raw.match(pattern);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** `fnm --version` prints `fnm 1.38.1`. */
export function parseFnmVersion(raw: string): SemVer | null {
  return parseSemVerAnywhere(raw, /(\d+)\.(\d+)\.(\d+)/);
}

/** `git --version` prints `git version 2.43.0`, or `2.43.0.windows.1` on win32; the suffix is dropped. */
export function parseGitVersion(raw: string): SemVer | null {
  return parseSemVerAnywhere(raw, /git version\s+(\d+)\.(\d+)\.(\d+)/i);
}

/** `winget --version` prints `v1.29.290`. */
export function parseWingetVersion(raw: string): SemVer | null {
  return parseSemVer(raw, 'optional-v');
}

function wellKnownFnmDirectories(env: PathEnv): string[] {
  if (env.platform === 'win32') {
    const { LOCALAPPDATA, FNM_DIR, APPDATA } = env.env;
    return [
      // winget's fnm manifest links here — see the comment on `fnm.install`.
      LOCALAPPDATA ? win32.join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : undefined,
      FNM_DIR?.trim() || (APPDATA ? win32.join(APPDATA, 'fnm') : undefined),
    ].filter((directory): directory is string => Boolean(directory?.trim()));
  }

  return [posix.join(env.homeDir, '.local', 'share', 'fnm'), posix.join(env.homeDir, '.fnm')];
}

function wellKnownGitDirectories(env: PathEnv): string[] {
  if (env.platform !== 'win32') return [];
  const { ProgramFiles } = env.env;
  return ProgramFiles ? [win32.join(ProgramFiles, 'Git', 'cmd')] : [];
}

function wellKnownWingetDirectories(env: PathEnv): string[] {
  if (env.platform !== 'win32') return [];
  const { LOCALAPPDATA } = env.env;
  return LOCALAPPDATA ? [win32.join(LOCALAPPDATA, 'Microsoft', 'WindowsApps')] : [];
}

/** Second helper-managed Node manager; win32-installable, unlike nvm. */
export const FNM_RUNTIME_DEFINITION: RuntimeDefinition = {
  id: 'fnm',
  binaryNames: ['fnm'],
  versionArgs: ['--version'],
  parseVersion: parseFnmVersion,
  wellKnownDirs: wellKnownFnmDirectories,
};

/** Probed as a prerequisite for the Windows recipes; never installed by MangoStudio. */
export const GIT_RUNTIME_DEFINITION: RuntimeDefinition = {
  id: 'git',
  binaryNames: ['git'],
  versionArgs: ['--version'],
  parseVersion: parseGitVersion,
  wellKnownDirs: wellKnownGitDirectories,
};

/** Probed as a prerequisite for the Windows recipes; never installed by MangoStudio. */
export const WINGET_RUNTIME_DEFINITION: RuntimeDefinition = {
  id: 'winget',
  binaryNames: ['winget'],
  versionArgs: ['--version'],
  parseVersion: parseWingetVersion,
  wellKnownDirs: wellKnownWingetDirectories,
};
