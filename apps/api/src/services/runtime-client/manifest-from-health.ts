/**
 * Rebuild a capability manifest from a health report.
 *
 * The hub cannot call `createLocalRuntimeManifest` for a remote peer — that
 * function probes *this* process's shells and git. The health report already
 * carries the peer's platform facts and allow set; this just projects them into
 * the shape hello advertises.
 */

import type { RuntimeHealthReport } from '@mangostudio/shared/runtime-home';
import type {
  RuntimeCapabilityManifest,
  RuntimeShellKind,
} from '@mangostudio/shared/runtime-protocol';

const SHELL_KINDS = new Set<string>(['bash', 'zsh', 'powershell']);

export function capabilityManifestFromHealth(
  report: RuntimeHealthReport
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
    },
    profile: report.profile,
  };
}
