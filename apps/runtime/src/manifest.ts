import { homedir } from 'node:os';
import type {
  ExternalAgentTargetId,
  ExternalIdentityIsolation,
} from '@mangostudio/shared/external-agents';
import { directoryHashDomainVersion } from '@mangostudio/shared/library';
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
  allow: RuntimeCapabilityAllow = RUNTIME_CONSENT_PRESETS.full,
  externalAgents: {
    readonly targetIds?: readonly ExternalAgentTargetId[];
    readonly identityIsolation?: ExternalIdentityIsolation;
  } = {}
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
      externalAgents: allow.externalAgents === true,
    },
    ...(externalAgents.targetIds && externalAgents.targetIds.length > 0
      ? { externalAgents: [...externalAgents.targetIds] }
      : {}),
    ...(externalAgents.identityIsolation
      ? { identityIsolation: externalAgents.identityIsolation }
      : {}),
    profile: profileForAllow(allow),
    // This build decodes `hello_ack.hub`. Frame envelopes are closed, so the
    // hub withholds that field until a runtime says it will not choke on it.
    acceptsHubIdentity: true,
    // Every filesystem method in this build re-checks its own targets against
    // the call's `pathPolicy` (see `services/fs.ts`). Stated rather than
    // inferred from the version, because the hub's alternative is to assume —
    // and assuming enforcement is the failure this field exists to prevent.
    enforcesPathPolicy: true,
    // Derived from the domain string this build actually hashes with, so a
    // later v3 cannot advertise v2 while computing v3. File hashes are
    // unversioned; only the directory domain moved.
    directoryHashDomain: directoryHashDomainVersion(),
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
