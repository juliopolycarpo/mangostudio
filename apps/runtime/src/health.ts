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
  type RuntimeHealthReport,
  type RuntimeSlot,
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
  const manifest = createLocalRuntimeManifest();

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
    profile: config.profile,
    allow: config.allow,
    setup: config.setup,
    platform: manifest.platform,
    arch: manifest.arch,
    homeDir: manifest.homeDir,
    shells: [...manifest.shells],
    git: manifest.git,
    lastError: error,
  };
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

  if (report.lastError) {
    findings.push({
      severity: 'fail',
      title: 'Config',
      detail: report.lastError,
      fix: 'mangostudio-runtime setup',
    });
  }

  findings.push(consentFinding(report));

  if (report.version && report.version !== report.runtimeVersion) {
    findings.push({
      severity: 'warn',
      title: 'Version',
      detail: `the config records ${report.version} but this binary is ${report.runtimeVersion}; the install was replaced without updating the config`,
      fix: 'mangostudio-runtime setup --yes',
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

  return findings;
}

function consentFinding(report: RuntimeHealthReport): RuntimeDoctorFinding {
  if (report.setup.state === 'pending') {
    return {
      severity: 'fail',
      title: 'Consent',
      detail: `nobody has said what a hub may do on this machine, so the ${report.slot} runtime refuses to serve`,
      fix: 'mangostudio-runtime setup',
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
      fix: 'mangostudio-runtime setup',
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
