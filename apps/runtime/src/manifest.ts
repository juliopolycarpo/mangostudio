import { homedir } from 'node:os';
import {
  profileForAllow,
  RUNTIME_CONSENT_PRESETS,
  type RuntimeCapabilityAllow,
} from '@mangostudio/shared/runtime-home';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import { HIDDEN_WINDOW } from './services/process-window';
import { isShellAvailable } from './services/shell';

/**
 * Announces what this runtime may execute under the recorded consent.
 *
 * Effective features are the intersection of what the machine's owner granted
 * and what is actually present (git binary, shells). Advertising a capability
 * the binary cannot deliver is a worse bug than under-reporting.
 */
export function createLocalRuntimeManifest(
  allow: RuntimeCapabilityAllow = RUNTIME_CONSENT_PRESETS.full
): RuntimeCapabilityManifest {
  const shells = (['bash', 'zsh', 'powershell'] as const).filter(isShellAvailable);
  const git = inspectGit();
  const tools =
    allow.fsRead ||
    allow.fsWrite ||
    allow.shell ||
    allow.git ||
    allow.mcp ||
    allow.probing ||
    allow.library ||
    allow.checkpoints;

  return {
    platform: process.platform,
    arch: process.arch,
    pathStyle: process.platform === 'win32' ? 'win32' : 'posix',
    homeDir: homedir(),
    shells: allow.shell ? shells : [],
    git: {
      available: allow.git && git.available,
      ...(allow.git && git.version ? { version: git.version } : {}),
    },
    features: {
      tools,
      git: allow.git && git.available,
      probing: allow.probing,
      mcp: allow.mcp,
      library: allow.library,
      checkpoints: allow.checkpoints,
      fsRead: allow.fsRead,
      fsWrite: allow.fsWrite,
      shell: allow.shell,
      update: allow.update,
    },
    profile: profileForAllow(allow),
    // This build decodes `hello_ack.hub`. Frame envelopes are closed, so the
    // hub withholds that field until a runtime says it will not choke on it.
    acceptsHubIdentity: true,
    // Sent beside the intersection so a reader can tell the two apart: `git`
    // false in `features` with `allow.git` true is a machine without git, not
    // an owner who refused it.
    allow,
  };
}

function inspectGit(): RuntimeCapabilityManifest['git'] {
  const executable = Bun.which('git');
  if (!executable) return { available: false };

  const result = Bun.spawnSync([executable, '--version'], {
    stdout: 'pipe',
    stderr: 'ignore',
    ...HIDDEN_WINDOW,
  });
  if (!result.success) return { available: false };
  const version = result.stdout
    .toString()
    .trim()
    .replace(/^git version\s+/i, '');
  return version ? { available: true, version } : { available: true };
}
