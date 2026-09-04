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
import { supportsPty } from './services/terminal/pty';

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
  const gh = inspectGh();
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
    // Gated on `git` because that is the weaker of the two capabilities `gh`
    // answers to — `gh.mutate` also needs `shell`, but a machine that granted
    // neither has no `gh` worth announcing. The version travels with it so a
    // later consumer can degrade one feature on an old CLI instead of hiding
    // the whole panel.
    gh: {
      available: allow.git && gh.available,
      ...(allow.git && gh.version ? { version: gh.version } : {}),
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
      toolchain: true,
    },
    ...(externalAgents.targetIds && externalAgents.targetIds.length > 0
      ? { externalAgents: [...externalAgents.targetIds] }
      : {}),
    ...(externalAgents.identityIsolation
      ? { identityIsolation: externalAgents.identityIsolation }
      : {}),
    // Consent and ability together, like `git`: a machine whose owner refused
    // `shell`, or that has no shell to run, or a Bun without a PTY, all answer
    // false rather than advertising a panel that every open would refuse.
    terminal: allow.shell && shells.length > 0 && supportsPty(),
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

/**
 * Probes the GitHub CLI the same way {@link inspectGit} probes Git, with one
 * difference that matters: `gh --version` prints two lines — the version and a
 * release URL — so only the first is parsed. A plain `.trim()`, which is all
 * Git's single-line output needs, would put a URL in the manifest and blow past
 * the health report's 64-character cap on the field.
 */
function inspectGh(): NonNullable<RuntimeCapabilityManifest['gh']> {
  // Resolved against the *live* PATH rather than the one this process started
  // with, because that is the PATH `buildGhEnvironment()` hands the spawn. The
  // two would otherwise be able to disagree — the manifest announcing a `gh`
  // the execution path cannot find, or hiding one it can — and a capability
  // announcement that does not describe the executable that will actually run
  // is worse than no announcement. `Bun.which` falls back to the startup PATH
  // when the option is undefined, so an unset PATH keeps the old behavior.
  const executable = Bun.which('gh', { PATH: process.env.PATH });
  if (!executable) return { available: false };

  const result = Bun.spawnSync([executable, '--version'], {
    stdout: 'pipe',
    stderr: 'ignore',
    ...HIDDEN_WINDOW,
  });
  if (!result.success) return { available: false };
  const version = parseGhVersion(result.stdout.toString());
  return version ? { available: true, version } : { available: true };
}

/** `gh version 2.97.0 (2026-07-31)\nhttps://...` becomes `2.97.0`. */
export function parseGhVersion(output: string): string {
  const firstLine = output.split('\n', 1)[0]?.trim() ?? '';
  return firstLine
    .replace(/^gh version\s+/i, '')
    .replace(/\s*\(.*$/, '')
    .trim();
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
