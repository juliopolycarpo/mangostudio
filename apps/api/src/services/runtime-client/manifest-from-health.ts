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
 *
 * The effective feature is consented ∩ available ∩ implemented, each from its
 * own source. A peer that announces `implementation` in hello names the
 * implemented set directly, so a later consent grant shows up on the next
 * refresh while a build gap stays closed. A peer that does not (an older
 * runtime, including the TypeScript host) folds consent into its hello
 * `features`, so those are the ceiling, fail-closed: a grant made after the
 * handshake needs a reconnect before the hub offers it.
 */

import {
  acceptedRuntimeImplementation,
  effectiveTools,
  type RuntimeCapabilityManifest,
  type RuntimeImplementation,
  type RuntimeShellKind,
} from '@mangostudio/shared/runtime-contract';
import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';

const SHELL_KINDS = new Set<string>(['bash', 'zsh', 'powershell']);

export function capabilityManifestFromHealth(
  report: RuntimeHealthReport,
  handshake?: RuntimeCapabilityManifest
): RuntimeCapabilityManifest {
  const allow = report.allow;
  // Judged once: a descriptor this build cannot interpret is not announced.
  const implementation = acceptedRuntimeImplementation(handshake?.implementation);
  const shells = allow.shell
    ? report.shells.filter((shell): shell is RuntimeShellKind => SHELL_KINDS.has(shell))
    : [];
  const allowedFeatures: Omit<RuntimeCapabilityManifest['features'], 'tools'> = {
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
  };

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
    ...terminalOf(report, implementation),
    features: applyImplementationCeiling(
      allowedFeatures,
      implementationCeiling(handshake, implementation)
    ),
    ...(report.externalAgents?.targets.length
      ? { externalAgents: [...report.externalAgents.targets] }
      : {}),
    ...(report.externalAgents?.identityIsolation
      ? { identityIsolation: report.externalAgents.identityIsolation }
      : {}),
    ...(handshake?.enforcesPathPolicy === undefined
      ? {}
      : { enforcesPathPolicy: handshake.enforcesPathPolicy }),
    ...(handshake?.publishesWindowsSlot === undefined
      ? {}
      : { publishesWindowsSlot: handshake.publishesWindowsSlot }),
    ...(handshake?.directoryHashDomain === undefined
      ? {}
      : { directoryHashDomain: handshake.directoryHashDomain }),
    ...(handshake?.terminalCloseAfterRevocation === undefined
      ? {}
      : { terminalCloseAfterRevocation: handshake.terminalCloseAfterRevocation }),
    ...(implementation ? { implementation } : {}),
    profile: report.profile,
    allow,
  };
}

/**
 * The refreshed `terminal` flag: absent stays absent, and a peer that declared
 * its implementation cannot report a PTY its build does not carry.
 */
function terminalOf(
  report: RuntimeHealthReport,
  implementation: RuntimeImplementation | undefined
): Pick<RuntimeCapabilityManifest, 'terminal'> {
  if (report.terminal === undefined) return {};
  const implemented = implementation?.features.terminal ?? true;
  return { terminal: report.terminal && implemented };
}

/**
 * What the peer's build implements, as a `features`-shaped ceiling.
 *
 * With `implementation` announced, the ceiling comes from it and is
 * independent of the consent that was in force at the handshake. Without it,
 * the handshake `features` are the ceiling exactly as sent: they fold consent
 * in, so a refusal there cannot be told apart from a build gap and must stay a
 * refusal until the peer reconnects. `toolchain` is a request shape rather
 * than an implemented group, so it is always the handshake's own answer.
 *
 * @example
 * implementationCeiling(hello, accepted)?.shell // accepted.features.shell when announced
 */
function implementationCeiling(
  handshake: RuntimeCapabilityManifest | undefined,
  implementation: RuntimeImplementation | undefined
): RuntimeCapabilityManifest['features'] | undefined {
  if (!handshake) return undefined;
  if (!implementation) return handshake.features;
  const implemented = implementation.features;
  return {
    tools: true,
    git: implemented.git,
    probing: implemented.probing,
    mcp: implemented.mcp,
    library: implemented.library,
    checkpoints: implemented.checkpoints,
    fsRead: implemented.fsRead,
    fsWrite: implemented.fsWrite,
    shell: implemented.shell,
    update: implemented.update,
    externalAgents: implemented.externalAgents,
    ...(handshake.features.toolchain === undefined
      ? {}
      : { toolchain: handshake.features.toolchain }),
  };
}

function applyImplementationCeiling(
  allowed: Omit<RuntimeCapabilityManifest['features'], 'tools'>,
  implemented?: RuntimeCapabilityManifest['features']
): RuntimeCapabilityManifest['features'] {
  // Every branch derives `tools` from effective groups only (#1100): ORing raw
  // consent would claim tools for a group the machine or build cannot serve.
  if (!implemented) return { tools: effectiveTools(allowed), ...allowed };

  const effective = {
    git: allowed.git && implemented.git,
    probing: allowed.probing && implemented.probing,
    mcp: allowed.mcp && implemented.mcp,
    library: allowed.library && implemented.library,
    checkpoints: allowed.checkpoints && implemented.checkpoints,
    // These keys predate explicit implementation gating. Absence means an
    // older peer whose implementation is assumed, while an explicit false is
    // an authoritative refusal from a newer peer such as the Rust runtime.
    fsRead: allowed.fsRead && implemented.fsRead !== false,
    fsWrite: allowed.fsWrite && implemented.fsWrite !== false,
    shell: allowed.shell && implemented.shell !== false,
    update: allowed.update && implemented.update !== false,
    // Absence is fail-closed for privileged vendor-process hosting.
    externalAgents: allowed.externalAgents && implemented.externalAgents === true,
    // Toolchain support describes a request shape, not consent. Health cannot
    // recompute it, so preserve exactly what the build announced in hello.
    ...(implemented.toolchain === undefined ? {} : { toolchain: implemented.toolchain }),
  } satisfies Omit<RuntimeCapabilityManifest['features'], 'tools'>;

  // The permission and implementation operands can each be true for a
  // different group, so intersecting their precomputed aggregates would be
  // unsound; only the effective groups decide.
  return { tools: effectiveTools(effective), ...effective };
}
