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
  type RuntimeExternalAgentHealth,
  type RuntimeHealthReport,
  type RuntimePlatformId,
  type RuntimeSlot,
  resolveRuntimePlatformId,
  runtimeSlotAuditLogPath,
  SHELL_TRUST_NOTICE,
} from '@mangostudio/shared/runtime-home';
import { readRuntimeAuditError } from './audit-log';
import { loadRuntimeConfig } from './config';
import { createLocalRuntimeManifest } from './manifest';
import {
  readRuntimeSlotState,
  resolveRuntimeBinaryPath,
  resolveRuntimeSlot,
  resolveRuntimeSource,
} from './runtime-home';
import {
  collectServiceDoctorDetails,
  RUNTIME_SERVICE_DOCS_URL,
  RUNTIME_SERVICE_NO_SESSION_BUS_ERROR,
  type RuntimeServiceExecDeps,
  shouldCheckRuntimeService,
} from './services/runtime-service';

export interface RuntimeHealthOptions {
  readonly runtimeVersion: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Which slot to report on; without it, the one this binary sits in. */
  readonly slot?: RuntimeSlot;
  readonly externalAgents?: RuntimeExternalAgentHealth;
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
  const auditPath = runtimeSlotAuditLogPath(slot, {
    mangoHome: loadRuntimeConfig(env).mangoHome,
    platform: process.platform,
  });
  const auditError = config.audit.enabled ? await readRuntimeAuditError(auditPath) : null;

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
    // Read, never derived: only the installer knew which rolling build it took
    // these bytes from, and the binary itself cannot tell you — its version
    // string is exactly what the rolling filename threw away.
    sourceSha: config.sourceSha,
    profile: denyEverything ? 'none' : config.profile,
    allow,
    setup: config.setup,
    platform: manifest.platform,
    arch: manifest.arch,
    ...(platformId ? { platformId } : {}),
    homeDir: manifest.homeDir,
    shells: [...manifest.shells],
    git: manifest.git,
    // Carried on the report, not only on `hello`: the hub rebuilds a remote
    // peer's manifest from health after every consent change, so a `gh` that
    // travelled on the handshake alone would disappear on the first refresh.
    ...(manifest.gh ? { gh: manifest.gh } : {}),
    ...(manifest.terminal === undefined ? {} : { terminal: manifest.terminal }),
    lastError: error,
    audit: config.audit,
    ...(auditError ? { auditError } : {}),
    ...(options.externalAgents ? { externalAgents: options.externalAgents } : {}),
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

  if (report.externalAgents) {
    const sessions = report.externalAgents.liveSessions
      .map(
        (session) =>
          `${session.targetId}:${session.sessionId} ${session.state} ${Math.round(session.ageMs / 1_000)}s`
      )
      .join(', ');
    findings.push({
      severity: 'ok',
      title: 'External agents',
      detail:
        report.externalAgents.liveSessionCount === 0
          ? `${report.externalAgents.targets.length} adapter target(s), no live sessions`
          : `${report.externalAgents.liveSessionCount} live session(s): ${sessions}`,
    });
  }

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

  if (report.audit === undefined) {
    findings.push({
      severity: 'ok',
      title: 'Audit',
      detail: 'not reported by this runtime (older binary)',
    });
  } else if (report.audit.enabled) {
    if (report.auditError) {
      findings.push({
        severity: 'warn',
        title: 'Audit',
        detail: `enabled, but the last write failed: ${report.auditError}`,
        fix: `mangostudio-runtime setup --slot ${report.slot} --audit off`,
      });
    } else {
      findings.push({
        severity: 'ok',
        title: 'Audit',
        detail: "recording protocol calls to this slot's audit.log",
      });
    }
  } else {
    findings.push({
      severity: 'ok',
      title: 'Audit',
      detail: 'off — run setup --audit on to record what a hub asks this machine to do',
    });
  }

  return findings;
}

/**
 * Service findings apply only to dial-in `remote` slots with connect or serve
 * configured. Hub-spawned stdio/WSL/SSH runtimes are not expected to have a unit.
 */
export async function diagnoseRuntimeServiceHealth(
  report: RuntimeHealthReport,
  env?: NodeJS.ProcessEnv,
  deps?: RuntimeServiceExecDeps
): Promise<RuntimeDoctorFinding[]> {
  const { config } = await readRuntimeSlotState(report.slot, env);
  if (
    !shouldCheckRuntimeService({
      slot: report.slot,
      hubUrl: config.hubUrl,
      serveListen: config.serveListen,
    })
  ) {
    return [];
  }

  const { status, currentBinaryPath } = await collectServiceDoctorDetails(env, deps);
  const findings: RuntimeDoctorFinding[] = [];
  const installFixConnect = 'mangostudio-runtime service install --mode connect';
  const installFixServe = 'mangostudio-runtime service install --mode serve';
  const fix =
    config.hubUrl && !config.serveListen
      ? installFixConnect
      : config.serveListen && !config.hubUrl
        ? installFixServe
        : 'mangostudio-runtime service install --mode connect|serve';

  // Where `service install` refuses, doctor must not name it as the fix — the
  // one command it could suggest is the one command guaranteed to fail. Each of
  // these reports what is true here and points at the manual alternative.
  if (status.platform === 'unsupported') {
    return [
      {
        severity: 'warn',
        title: 'Service',
        detail: `${status.error ?? 'no user-level service manager here'} — supervise this runtime yourself (${RUNTIME_SERVICE_DOCS_URL})`,
      },
    ];
  }

  // A non-interactive `ssh host cmd` carries no session bus, so systemctl can
  // be asked nothing at all. Reading that as "not installed" would call a
  // healthy, running unit a defect on the one path 020 uses to reach it.
  if (status.error === RUNTIME_SERVICE_NO_SESSION_BUS_ERROR) {
    return [
      {
        severity: 'warn',
        title: 'Service',
        detail: 'cannot read the user service without a session bus',
        fix: 'XDG_RUNTIME_DIR=/run/user/$(id -u) mangostudio-runtime doctor',
      },
    ];
  }

  // The supervisor answered with an error rather than a state. Calling that
  // "not installed" and prescribing an install would be the same lie as the
  // session-bus case, with a different cause.
  if (status.error) {
    return [
      {
        severity: 'warn',
        title: 'Service',
        detail: `could not read the user service: ${status.error}`,
      },
    ];
  }

  if (!status.installed) {
    findings.push({
      severity: 'warn',
      title: 'Service',
      detail: 'no user-level service keeps this runtime running across logout or reboot',
      fix,
    });
    return findings;
  }

  if (!status.enabled) {
    findings.push({
      severity: 'warn',
      title: 'Service',
      detail: 'the service unit is installed but not enabled',
      fix,
    });
  } else {
    findings.push({
      severity: 'ok',
      title: 'Service',
      detail: 'user-level unit is enabled',
    });
  }

  if (!status.running) {
    findings.push({
      severity: 'fail',
      title: 'Service',
      detail: 'the service unit is not running',
      fix,
    });
  } else {
    findings.push({
      severity: 'ok',
      title: 'Service',
      detail: 'user-level unit is running',
    });
  }

  if (status.platform === 'linux' && status.linger === false) {
    findings.push({
      severity: 'warn',
      title: 'Linger',
      detail: 'loginctl linger is off — the user service stops when you log out',
      fix: 'sudo loginctl enable-linger $USER',
    });
  } else if (status.platform === 'linux' && status.linger === true) {
    findings.push({ severity: 'ok', title: 'Linger', detail: 'loginctl linger is on' });
  }

  if (status.execUsesCurrent === false) {
    findings.push({
      severity: 'warn',
      title: 'Service',
      detail:
        'the unit does not point at the slot current symlink — upgrades may leave a stale path',
      fix,
    });
  } else if (status.execUsesCurrent === true) {
    findings.push({
      severity: 'ok',
      title: 'Service',
      detail: 'unit ExecStart uses the current symlink',
    });
  }

  // The fix used to be absent, because only a hub push could put bytes there
  // and this machine could do nothing about it. `install` is that command now:
  // it copies the binary already running this check into the slot.
  if (status.currentBinaryPresent === false) {
    findings.push({
      severity: 'fail',
      title: 'Service',
      detail: `no runtime binary at ${currentBinaryPath} — the unit cannot start until the slot is installed`,
      fix: `mangostudio-runtime install --slot ${report.slot}`,
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
