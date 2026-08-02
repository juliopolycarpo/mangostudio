import { homedir } from 'node:os';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import { isShellAvailable } from './services/shell';

/** Announces what the local runtime can execute in this release. */
export function createLocalRuntimeManifest(): RuntimeCapabilityManifest {
  const shells = (['bash', 'zsh', 'powershell'] as const).filter(isShellAvailable);
  return {
    platform: process.platform,
    arch: process.arch,
    pathStyle: process.platform === 'win32' ? 'win32' : 'posix',
    homeDir: homedir(),
    shells,
    git: inspectGit(),
    features: {
      tools: true,
      git: true,
      probing: true,
      mcp: true,
      library: false,
      checkpoints: true,
    },
  };
}

function inspectGit(): RuntimeCapabilityManifest['git'] {
  const executable = Bun.which('git');
  if (!executable) return { available: false };

  const result = Bun.spawnSync([executable, '--version'], {
    stdout: 'pipe',
    stderr: 'ignore',
  });
  if (!result.success) return { available: false };
  const version = result.stdout
    .toString()
    .trim()
    .replace(/^git version\s+/i, '');
  return version ? { available: true, version } : { available: true };
}
