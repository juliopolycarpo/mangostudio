/**
 * Rebuild a capability manifest from a health report.
 *
 * The hub cannot call `createLocalRuntimeManifest` for a remote peer — that
 * function probes *this* process's shells and git. The health report already
 * carries the peer's platform facts and allow set; this just projects them into
 * the shape hello advertises.
 *
 * Health answers what the machine's owner allowed and what the machine has. It
 * does not answer what the peer's *build* can do, and those answers only ever
 * arrive on `hello` — so they are carried forward from the handshake rather
 * than recomputed. Dropping them would silently downgrade a peer to "older"
 * on the first refresh of a connection it already completed.
 */

import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';
import type {
  RuntimeCapabilityManifest,
  RuntimeShellKind,
} from '@mangostudio/shared/runtime-protocol';

const SHELL_KINDS = new Set<string>(['bash', 'zsh', 'powershell']);

export function capabilityManifestFromHealth(
  report: RuntimeHealthReport,
  handshake?: RuntimeCapabilityManifest
): RuntimeCapabilityManifest {
  const allow = report.allow;
  const shells = allow.shell
    ? report.shells.filter((shell): shell is RuntimeShellKind => SHELL_KINDS.has(shell))
    : [];
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
    platform: report.platform,
    arch: report.arch,
    pathStyle: report.platform === 'win32' ? 'win32' : 'posix',
    homeDir: report.homeDir,
    shells,
    git: report.git,
    // Spread conditionally because the key is optional on both shapes and
    // absent means unavailable: writing `gh: report.gh` would put an explicit
    // `undefined` on a manifest that other code reads with `?.available`, and
    // writing `gh: report.gh ?? { available: false }` would tell the hub a peer
    // answered "no gh" when it never answered at all.
    ...(report.gh ? { gh: report.gh } : {}),
    // Same rule as `gh`: absent stays absent, so "too old to say" is never
    // rewritten as "said no".
    ...(report.terminal === undefined ? {} : { terminal: report.terminal }),
    features: {
      tools,
      git: allow.git && report.git.available,
      probing: allow.probing,
      mcp: allow.mcp,
      library: allow.library,
      checkpoints: allow.checkpoints,
      fsRead: allow.fsRead,
      fsWrite: allow.fsWrite,
      // Consent, not availability — the same thing `hello` says. A machine that
      // grants shell but has no bash/zsh/powershell is reported through the
      // empty `shells` list, so a refresh cannot disagree with the handshake
      // about whether the owner said yes.
      shell: allow.shell,
      update: allow.update,
      // Unlike the older feature keys, missing consent is a refusal. A health
      // report from a 1.0 peer must never be upgraded into permission to spawn
      // a vendor process merely because the hub knows the newer key.
      externalAgents: allow.externalAgents === true,
    },
    ...(report.externalAgents?.targets.length
      ? { externalAgents: [...report.externalAgents.targets] }
      : {}),
    ...(report.externalAgents?.identityIsolation
      ? { identityIsolation: report.externalAgents.identityIsolation }
      : {}),
    ...(handshake?.acceptsHubIdentity === undefined
      ? {}
      : { acceptsHubIdentity: handshake.acceptsHubIdentity }),
    ...(handshake?.enforcesPathPolicy === undefined
      ? {}
      : { enforcesPathPolicy: handshake.enforcesPathPolicy }),
    ...(handshake?.publishesWindowsSlot === undefined
      ? {}
      : { publishesWindowsSlot: handshake.publishesWindowsSlot }),
    ...(handshake?.directoryHashDomain === undefined
      ? {}
      : { directoryHashDomain: handshake.directoryHashDomain }),
    profile: report.profile,
    allow,
  };
}
