import { posix, win32 } from 'node:path';
import type { PathEnv } from '../../runtime-env';
import type { RuntimeDefinition, SemVer } from './binary-scan';

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
    const { ProgramFiles, LOCALAPPDATA, NVM_SYMLINK, VOLTA_HOME } = env.env;
    return [
      NVM_SYMLINK,
      ProgramFiles ? win32.join(ProgramFiles, 'nodejs') : undefined,
      env.env['ProgramFiles(x86)']
        ? win32.join(env.env['ProgramFiles(x86)'] as string, 'nodejs')
        : undefined,
      LOCALAPPDATA ? win32.join(LOCALAPPDATA, 'Programs', 'nodejs') : undefined,
      VOLTA_HOME ? win32.join(VOLTA_HOME, 'bin') : undefined,
    ].filter((directory): directory is string => Boolean(directory?.trim()));
  }

  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    posix.join(env.homeDir, '.volta', 'bin'),
    posix.join(env.homeDir, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
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
