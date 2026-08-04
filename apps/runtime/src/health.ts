/**
 * One health truth for this machine.
 *
 * `health --json` prints this and (from 019) the `runtime.health` protocol
 * method returns it, so a terminal on the machine and an environment card in a
 * browser cannot disagree about what a runtime is or what it may do. That is
 * why it is a single payload rather than a set of getters: a hub that reached a
 * dial-in runtime can never run this CLI, and a person at the machine can never
 * see the hub's cached manifest.
 *
 * `doctor` is this plus a reading of it — what is wrong, and the command that
 * fixes it.
 */

import {
  deniedCapabilities,
  RUNTIME_CONSENT_PRESETS,
  type RuntimeHealthReport,
  type RuntimePlatformId,
  type RuntimeSlot,
  resolveRuntimePlatformId,
  SHELL_TRUST_NOTICE,
} from '@mangostudio/shared/runtime-home';
import { createLocalRuntimeManifest } from './manifest';
import {
  readRuntimeSlotState,
  resolveRuntimeBinaryPath,
  resolveRuntimeSlot,
  resolveRuntimeSource,
} from './runtime-home';

export interface RuntimeHealthOptions {
  readonly runtimeVersion: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Which slot to report on; without it, the one this binary sits in. */
  readonly slot?: RuntimeSlot;
}

export async function collectRuntimeHealth(
  options: RuntimeHealthOptions
): Promise<RuntimeHealthReport> {
  const env = options.env;
  const slot = options.slot ?? resolveRuntimeSlot(env);
  const { config, error } = await readRuntimeSlotState(slot, env);
  // An unreadable config is an unknown answer, and an unknown answer is never
  // yes. `readRuntimeSlotState` hands back the slot default alongside its
  // error — full, for `host` and `wsl` — while the consent source the dispatch
  // gate reads applies `none` to the same failure. Reporting the default here
  // would advertise capabilities every gated call refuses, and (once the hub
  // refreshes from this payload) project them onto the environment card.
  const denyEverything = error !== null;
  const allow = denyEverything ? RUNTIME_CONSENT_PRESETS.none : config.allow;
  const manifest = createLocalRuntimeManifest(allow);
  const platformId = resolveRunningRuntimePlatformId(manifest.platform, manifest.arch);

  return {
    schemaVersion: config.schemaVersion,
    slot,
    source: resolveRuntimeSource(env),
    runtimeVersion: options.runtimeVersion,
    version: config.version,
    // The live executable outranks the recorded one: a config written by an
    // installer describes what it put there, and this describes what is running.
    binaryPath: resolveRuntimeBinaryPath(env) ?? config.binaryPath,
    // Read, never recomputed. Hashing ~95 MB to answer "how are you" would make
    // the cheapest question the most expensive one; the installer writes it.
    digest: config.digest,
    profile: denyEverything ? 'none' : config.profile,
    allow,
    setup: config.setup,
    platform: manifest.platform,
    arch: manifest.arch,
    ...(platformId ? { platformId } : {}),
    homeDir: manifest.homeDir,
    shells: [...manifest.shells],
    git: manifest.git,
    lastError: error,
  };
}

/** Maps this process to the release binary identity the hub must download. */
export function resolveRunningRuntimePlatformId(
  platform: string = process.platform,
  arch: string = process.arch,
  glibcVersionRuntime: string | null | undefined = runningGlibcVersion()
): RuntimePlatformId | null {
  const kernel = platform === 'darwin' ? 'Darwin' : platform === 'linux' ? 'Linux' : platform;
  const machine = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch;
  return resolveRuntimePlatformId({
    kernel,
    machine,
    libc: platform === 'linux' && !glibcVersionRuntime ? 'musl' : 'glibc',
  });
}

function runningGlibcVersion(): string | undefined {
  const report = process.report?.getReport() as
    | { readonly header?: { readonly glibcVersionRuntime?: string } }
    | undefined;
  return report?.header?.glibcVersionRuntime;
}

export type RuntimeFindingSeverity = 'ok' | 'warn' | 'fail';

export interface RuntimeDoctorFinding {
  readonly severity: RuntimeFindingSeverity;
  readonly title: string;
  readonly detail: string;
  /** The command that resolves it, when one command does. */
  readonly fix?: string;
}

/**
 * Reads a health report the way a person would.
 *
 * Every `fail` carries a fix, because the machines this runs on are often
 * reachable only through the thing that is failing — someone reading this over
 * ssh needs the next command, not a diagnosis.
 */
export function diagnoseRuntimeHealth(report: RuntimeHealthReport): RuntimeDoctorFinding[] {
  const findings: RuntimeDoctorFinding[] = [];
  // Every fix names the slot the report is about. `setup` otherwise infers one
  // from where the binary sits, which is the wrong file whenever this report
  // was not about that slot either.
  const setupCommand = `mangostudio-runtime setup --slot ${report.slot}`;

  if (report.lastError) {
    findings.push({
      severity: 'fail',
      title: 'Config',
      detail: report.lastError,
      fix: setupCommand,
    });
  }

  findings.push(consentFinding(report, setupCommand));

  if (report.version && report.version !== report.runtimeVersion) {
    findings.push({
      severity: 'warn',
      title: 'Version',
      detail: `the config records ${report.version} but this binary is ${report.runtimeVersion}; the install was replaced without updating the config`,
      // Not `--yes`: that refuses without a profile to say yes to, so the fix
      // doctor printed would have exited on "Nothing to answer with".
      fix: setupCommand,
    });
  }

  if (report.allow.git && !report.git.available) {
    findings.push({
      severity: 'warn',
      title: 'Git',
      detail: "git is allowed here but is not on this machine's PATH",
    });
  } else if (report.git.available) {
    findings.push({
      severity: 'ok',
      title: 'Git',
      detail: report.git.version ? `git ${report.git.version}` : 'available',
    });
  }

  if (report.allow.shell && report.shells.length === 0) {
    findings.push({
      severity: 'warn',
      title: 'Shell',
      detail: 'shell is allowed here but none of bash, zsh, or powershell was found',
    });
  } else if (report.shells.length > 0) {
    findings.push({ severity: 'ok', title: 'Shell', detail: report.shells.join(', ') });
  }

  findings.push({
    severity: 'ok',
    title: 'Binary',
    detail:
      report.binaryPath ??
      'workspace entry (source checkout) — this runtime is not a compiled binary',
  });

  if (report.binaryPath) {
    findings.push({
      severity: 'ok',
      title: 'Slot',
      detail: `bytes under ${report.slot} at ${report.binaryPath}`,
    });
  } else if (report.version) {
    findings.push({
      severity: 'warn',
      title: 'Slot',
      detail: `config records version ${report.version} but no binary path is set`,
    });
  }

  return findings;
}

function consentFinding(report: RuntimeHealthReport, setupCommand: string): RuntimeDoctorFinding {
  // Reported before the presets are read, so `none` is never mistaken for a
  // choice someone made: an unreadable config refuses everything until it can
  // be read, which is a different problem with a different fix.
  if (report.lastError) {
    return {
      severity: 'fail',
      title: 'Consent',
      detail: `the ${report.slot} config could not be read, so every capability is refused until it can be`,
      fix: setupCommand,
    };
  }

  if (report.setup.state === 'pending') {
    return {
      severity: 'fail',
      title: 'Consent',
      detail: `nobody has said what a hub may do on this machine, so the ${report.slot} runtime refuses to serve`,
      fix: setupCommand,
    };
  }

  const denied = deniedCapabilities(report.allow);
  if (denied.length === 0) {
    return { severity: 'ok', title: 'Consent', detail: `full — ${SHELL_TRUST_NOTICE}` };
  }
  if (denied.length === Object.keys(report.allow).length) {
    return {
      severity: 'warn',
      title: 'Consent',
      detail: 'none — every capability is refused, so a hub can reach this runtime and do nothing',
      fix: setupCommand,
    };
  }
  return {
    severity: 'ok',
    title: 'Consent',
    detail: `${report.profile} — denied: ${denied.join(', ')}`,
  };
}

/** Worst severity present, which is what an exit code is made of. */
export function worstSeverity(findings: readonly RuntimeDoctorFinding[]): RuntimeFindingSeverity {
  if (findings.some((finding) => finding.severity === 'fail')) return 'fail';
  return findings.some((finding) => finding.severity === 'warn') ? 'warn' : 'ok';
}
