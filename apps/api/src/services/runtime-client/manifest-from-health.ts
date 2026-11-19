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
  isExternalAgentTargetId,
  isExternalIdentityIsolationMethod,
} from '@mangostudio/shared/external-agents';
import {
  acceptedRuntimeImplementation,
  effectiveTools,
  type RuntimeCapabilityManifest,
  type RuntimeImplementation,
  type RuntimeShellKind,
} from '@mangostudio/shared/runtime-contract';
import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';

const SHELL_KINDS = new Set<string>(['bash', 'zsh', 'powershell']);

/** A health report with the values this build cannot interpret removed, and which those were. */
export interface PrunedHealthReport {
  readonly report: RuntimeHealthReport;
  /** Distinct, in the order first seen; empty when the report named only known targets. */
  readonly skippedTargetIds: readonly string[];
  /** The isolation method this build has no enum member for; absent when it knew it or none was attested. */
  readonly skippedIsolationMethod?: string;
}

/**
 * Drops the `externalAgents` values that name something this build does not know:
 * a target id, or the identity-isolation method.
 *
 * Health accepts any well-formed token there so that a newer runtime hosting one
 * more vendor, or attesting one more isolation method, does not get its whole
 * report refused (and the manifest frozen). What such a value *means* is the
 * hub's call, and it is always the closed reading:
 *
 * - An unknown target id cannot be offered, routed to, or put in the closed
 *   manifest enum, so it is skipped. `liveSessionCount` stays the runtime's true
 *   total: a skipped session is still a live one on that machine.
 * - An unknown isolation method is unproven isolation. The attestation is
 *   dropped rather than guessed at, so the manifest carries no
 *   `identityIsolation` and everything gated on it (discovery, native sessions,
 *   turns) answers `EXTERNAL_ISOLATION_UNPROVEN`, even when `hello` announced a
 *   method this build knows: the newest answer from the peer wins.
 *
 * Both are reported to the caller to log.
 *
 * @example
 * pruneUnknownExternalAgentHealth(report).skippedTargetIds; // ['gemini']
 * pruneUnknownExternalAgentHealth(report).skippedIsolationMethod; // 'micro-vm'
 */
export function pruneUnknownExternalAgentHealth(report: RuntimeHealthReport): PrunedHealthReport {
  const externalAgents = report.externalAgents;
  if (!externalAgents) return { report, skippedTargetIds: [] };

  const skipped = new Set<string>();
  const known = (targetId: string): boolean => {
    if (isExternalAgentTargetId(targetId)) return true;
    skipped.add(targetId);
    return false;
  };
  const targets = externalAgents.targets.filter(known);
  const liveSessions = externalAgents.liveSessions.filter((session) => known(session.targetId));
  const { identityIsolation, ...withoutAttestation } = externalAgents;
  const skippedIsolationMethod =
    identityIsolation && !isExternalIdentityIsolationMethod(identityIsolation.method)
      ? identityIsolation.method
      : undefined;
  if (skipped.size === 0 && skippedIsolationMethod === undefined) {
    return { report, skippedTargetIds: [] };
  }

  const retained = skippedIsolationMethod === undefined ? externalAgents : withoutAttestation;
  return {
    report: { ...report, externalAgents: { ...retained, targets, liveSessions } },
    skippedTargetIds: [...skipped],
    ...(skippedIsolationMethod === undefined ? {} : { skippedIsolationMethod }),
  };
}

export function capabilityManifestFromHealth(
  report: RuntimeHealthReport,
  handshake?: RuntimeCapabilityManifest
): RuntimeCapabilityManifest {
  const allow = report.allow;
  // Health may list ids this build cannot name; the manifest's `externalAgents`
  // is a closed enum, so an id outside it is left out here even when the caller
  // did not prune the report first.
  const hostedTargets = report.externalAgents?.targets.filter(isExternalAgentTargetId) ?? [];
  // Two named members, not the object: health tolerates fields this build has
  // never heard of, and the manifest (and the `isolation` sent back on every
  // external-agent call) is a closed shape that would refuse them. A method
  // this build has no enum member for is unproven isolation, not a claim to
  // forward; reading it as any known one would invent an attestation.
  const reported = report.externalAgents?.identityIsolation;
  const attestation =
    reported && isExternalIdentityIsolationMethod(reported.method)
      ? { method: reported.method, credentialHomeFingerprint: reported.credentialHomeFingerprint }
      : undefined;
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
    ...terminalOf(report, handshake, implementation),
    features: applyImplementationCeiling(
      allowedFeatures,
      implementationCeiling(handshake, implementation)
    ),
    ...(hostedTargets.length ? { externalAgents: hostedTargets } : {}),
    ...(attestation ? { identityIsolation: attestation } : {}),
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
    ...(handshake?.terminalLoginArgv === undefined
      ? {}
      : { terminalLoginArgv: handshake.terminalLoginArgv }),
    ...(implementation ? { implementation } : {}),
    profile: report.profile,
    allow,
  };
}

/**
 * The refreshed `terminal` flag: absent stays absent, and a PTY is capped by
 * the same ceiling as `features` — the build's own answer when it declared one,
 * otherwise the handshake's `terminal`, which folds consent in and therefore
 * holds a refusal until the peer reconnects.
 */
function terminalOf(
  report: RuntimeHealthReport,
  handshake: RuntimeCapabilityManifest | undefined,
  implementation: RuntimeImplementation | undefined
): Pick<RuntimeCapabilityManifest, 'terminal'> {
  if (report.terminal === undefined) return {};
  const implemented = implementation?.features.terminal ?? handshake?.terminal ?? true;
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
