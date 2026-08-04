/**
 * User-level service install for `connect` and `serve` on the `remote` slot.
 *
 * Unit and plist bodies are dumb string templates; every manager command goes
 * through an injected exec seam so tests never touch live systemd or launchd.
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  RUNTIME_BINARY_BASENAME,
  RUNTIME_CURRENT_LINK_NAME,
  type RuntimeServiceMode,
  type RuntimeServiceStatus,
  type RuntimeSlot,
  runtimeSlotCurrentBinaryPath,
  runtimeSlotCurrentDir,
} from '@mangostudio/shared/runtime-home';
import { loadRuntimeConfig } from '../config';
import { RuntimeServiceManagementError } from '../errors';
import {
  type RuntimeSlotState,
  readPairingToken,
  readRuntimeSlotState,
  readServeToken,
} from '../runtime-home';

const RUNTIME_SERVICE_DOCS_URL =
  'https://github.com/juliopolycarpo/mangostudio/blob/main/docs/operations/remote-runtimes.md';

const SYSTEMD_UNIT_BASENAME = 'mangostudio-runtime.service';
const LAUNCHD_LABEL = 'com.mangostudio.runtime';

export interface RuntimeServiceExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RuntimeServiceExecDeps {
  readonly exec: (
    argv: readonly string[],
    options?: { readonly env?: NodeJS.ProcessEnv }
  ) => Promise<RuntimeServiceExecResult>;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly uid: number;
  readonly user: string;
  readonly hasSystemd: () => Promise<boolean>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly unlink: (path: string) => Promise<void>;
  readonly mkdir: (path: string) => Promise<void>;
}

const PAIRED_SLOT = 'remote' as const satisfies RuntimeSlot;

function homeOptions(env: NodeJS.ProcessEnv) {
  return { mangoHome: loadRuntimeConfig(env).mangoHome, platform: process.platform };
}

export function systemdUnitPath(home: string): string {
  return join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT_BASENAME);
}

function launchdPlistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

export function renderSystemdUnit(binaryPath: string, mode: RuntimeServiceMode): string {
  const execStart = `${escapeSystemdPath(binaryPath)} ${mode}`;
  return `[Unit]
Description=MangoStudio runtime (${mode})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function renderLaunchdPlist(binaryPath: string, mode: RuntimeServiceMode): string {
  const programArgs = plistStringArray([binaryPath, mode]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
</dict>
</plist>
`;
}

function escapeSystemdPath(path: string): string {
  if (/[\s"\\]/.test(path)) return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  return path;
}

function plistStringArray(values: readonly string[]): string {
  return values.map((value) => `    <string>${escapeXml(value)}</string>`).join('\n');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function execStartUsesCurrent(unitBody: string, currentBinaryPath: string): boolean {
  const normalized = currentBinaryPath.replaceAll('\\', '/');
  const alt = normalized.endsWith(`/${RUNTIME_BINARY_BASENAME}`)
    ? normalized
    : `${normalized}/${RUNTIME_BINARY_BASENAME}`;
  return (
    unitBody.includes(normalized) ||
    unitBody.includes(alt) ||
    unitBody.includes(`${RUNTIME_CURRENT_LINK_NAME}/`)
  );
}

function defaultRuntimeServiceExecDeps(
  env: NodeJS.ProcessEnv = process.env
): RuntimeServiceExecDeps {
  return {
    exec: async (argv, options) => {
      const child = Bun.spawn([...argv], {
        env: { ...env, ...options?.env },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { exitCode, stdout, stderr };
    },
    platform: process.platform,
    env,
    home: homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    user: env.USER ?? env.LOGNAME ?? 'user',
    hasSystemd: async () => {
      const result = await Bun.spawn(['which', 'systemctl'], {
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited;
      return result === 0;
    },
    writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
    readFile: (path) => readFile(path, 'utf8'),
    unlink: (path) => unlink(path),
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
  };
}

function sessionBusAvailable(env: NodeJS.ProcessEnv): boolean {
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  const dbus = env.DBUS_SESSION_BUS_ADDRESS?.trim();
  return Boolean(runtimeDir && runtimeDir.length > 0 && dbus && dbus.length > 0);
}

function refuseNoSessionBus(uid: number): never {
  throw new RuntimeServiceManagementError(
    'runtime_service_no_session_bus',
    [
      'No D-Bus session bus for systemd user services.',
      'Non-interactive SSH omits XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS.',
      `Try: XDG_RUNTIME_DIR=/run/user/${uid} mangostudio-runtime service <command>`,
      `See ${RUNTIME_SERVICE_DOCS_URL}`,
    ].join('\n')
  );
}

export async function assertServicePreconditions(
  mode: RuntimeServiceMode,
  slotState: RuntimeSlotState,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const { config, error } = slotState;
  if (error) {
    throw new RuntimeServiceManagementError(
      'runtime_service_setup_pending',
      `${error} Run "mangostudio-runtime setup --slot ${PAIRED_SLOT}" before installing a service.`
    );
  }
  if (config.setup.state === 'pending') {
    throw new RuntimeServiceManagementError(
      'runtime_service_setup_pending',
      `Runtime setup is pending on this machine. Run "mangostudio-runtime setup --slot ${PAIRED_SLOT}" first.`
    );
  }
  if (mode === 'connect') {
    if (!config.hubUrl) {
      throw new RuntimeServiceManagementError(
        'runtime_service_unconfigured',
        'Connect is not configured. Run "mangostudio-runtime connect --hub <url>" once before "service install --mode connect".'
      );
    }
    const token = await readPairingToken(PAIRED_SLOT, env);
    if (!token) {
      throw new RuntimeServiceManagementError(
        'runtime_service_unconfigured',
        'No pairing token is stored. Run "mangostudio-runtime connect" with a token before installing the connect service.'
      );
    }
    return;
  }
  if (!config.serveListen) {
    throw new RuntimeServiceManagementError(
      'runtime_service_unconfigured',
      'Serve is not configured. Run "mangostudio-runtime serve --listen <host:port>" once before "service install --mode serve".'
    );
  }
  const serveToken = await readServeToken(PAIRED_SLOT, env);
  if (!serveToken) {
    throw new RuntimeServiceManagementError(
      'runtime_service_unconfigured',
      'No serve token is stored. Run "mangostudio-runtime serve" once before installing the serve service.'
    );
  }
}

export function resolveInstallMode(
  requested: RuntimeServiceMode | undefined,
  config: RuntimeSlotState['config']
): RuntimeServiceMode {
  if (requested) return requested;
  const canConnect = Boolean(config.hubUrl);
  const canServe = Boolean(config.serveListen);
  if (canConnect && !canServe) return 'connect';
  if (canServe && !canConnect) return 'serve';
  if (!canConnect && !canServe) {
    throw new RuntimeServiceManagementError(
      'runtime_service_unconfigured',
      'Neither connect nor serve is configured. Run "mangostudio-runtime connect --hub <url>" or "mangostudio-runtime serve --listen <host:port>" once first.'
    );
  }
  throw new RuntimeServiceManagementError(
    'runtime_service_unconfigured',
    'Pass --mode connect or --mode serve. Both modes look configured; the service unit runs only one subcommand.'
  );
}

function currentBinaryForService(
  slot: RuntimeSlot = PAIRED_SLOT,
  env: NodeJS.ProcessEnv = process.env
): string {
  const options = { mangoHome: loadRuntimeConfig(env).mangoHome, platform: process.platform };
  return runtimeSlotCurrentBinaryPath(slot, options);
}

export interface RuntimeServiceManager {
  install(mode: RuntimeServiceMode): Promise<void>;
  uninstall(): Promise<void>;
  status(): Promise<RuntimeServiceStatus>;
}

export function createRuntimeServiceManager(
  deps: RuntimeServiceExecDeps = defaultRuntimeServiceExecDeps()
): RuntimeServiceManager {
  const slot = PAIRED_SLOT;
  const options = () => homeOptions(deps.env);

  const refuseUnsupported = (detail: string): never => {
    throw new RuntimeServiceManagementError(
      'runtime_service_unsupported',
      `${detail} See ${RUNTIME_SERVICE_DOCS_URL}`
    );
  };

  const linuxInstall = async (mode: RuntimeServiceMode): Promise<void> => {
    if (!sessionBusAvailable(deps.env)) refuseNoSessionBus(deps.uid);
    if (!(await deps.hasSystemd())) {
      refuseUnsupported('systemd user services are not available on this machine.');
    }
    const binaryPath = currentBinaryForService(slot, deps.env);
    const unitPath = systemdUnitPath(deps.home);
    await deps.mkdir(join(deps.home, '.config', 'systemd', 'user'));
    await deps.writeFile(unitPath, renderSystemdUnit(binaryPath, mode));
    await requireManagerCommand(
      deps,
      ['systemctl', '--user', 'daemon-reload'],
      'systemctl daemon-reload'
    );
    await requireManagerCommand(
      deps,
      ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT_BASENAME],
      'systemctl enable --now'
    );
    await attemptEnableLinger(deps);
  };

  const linuxUninstall = async (): Promise<void> => {
    if (!sessionBusAvailable(deps.env)) refuseNoSessionBus(deps.uid);
    if (!(await deps.hasSystemd())) {
      refuseUnsupported('systemd user services are not available on this machine.');
    }
    await runSystemctl(deps, ['--user', 'disable', '--now', SYSTEMD_UNIT_BASENAME]).catch(
      () => undefined
    );
    await deps.unlink(systemdUnitPath(deps.home)).catch(() => undefined);
    await runSystemctl(deps, ['--user', 'daemon-reload']).catch(() => undefined);
  };

  const darwinInstall = async (mode: RuntimeServiceMode): Promise<void> => {
    const binaryPath = currentBinaryForService(slot, deps.env);
    const plistPath = launchdPlistPath(deps.home);
    await deps.mkdir(join(deps.home, 'Library', 'LaunchAgents'));
    await deps.writeFile(plistPath, renderLaunchdPlist(binaryPath, mode));
    await runLaunchctl(deps, ['bootout', `gui/${deps.uid}/${LAUNCHD_LABEL}`]).catch(
      () => undefined
    );
    await requireManagerCommand(
      deps,
      ['launchctl', 'bootstrap', `gui/${deps.uid}`, plistPath],
      'launchctl bootstrap'
    );
    await requireManagerCommand(
      deps,
      ['launchctl', 'kickstart', '-k', `gui/${deps.uid}/${LAUNCHD_LABEL}`],
      'launchctl kickstart'
    );
  };

  const darwinUninstall = async (): Promise<void> => {
    const plistPath = launchdPlistPath(deps.home);
    await runLaunchctl(deps, ['bootout', `gui/${deps.uid}/${LAUNCHD_LABEL}`]).catch(
      () => undefined
    );
    await deps.unlink(plistPath).catch(() => undefined);
  };

  return {
    async install(mode) {
      const slotState = await readRuntimeSlotState(slot, deps.env);
      await assertServicePreconditions(mode, slotState, deps.env);
      if (deps.platform === 'win32') {
        refuseUnsupported('Windows service install is not implemented in the CLI yet.');
      }
      if (deps.platform === 'linux') return await linuxInstall(mode);
      if (deps.platform === 'darwin') return await darwinInstall(mode);
      refuseUnsupported('No user-level service manager is supported on this platform.');
    },

    async uninstall() {
      if (deps.platform === 'win32') {
        refuseUnsupported('Windows service install is not implemented in the CLI yet.');
      }
      if (deps.platform === 'linux') return await linuxUninstall();
      if (deps.platform === 'darwin') return await darwinUninstall();
      refuseUnsupported('No user-level service manager is supported on this platform.');
    },

    async status() {
      const slotState = await readRuntimeSlotState(slot, deps.env);
      const currentDir = runtimeSlotCurrentDir(slot, options());
      const configMode = inferConfiguredMode(slotState.config);

      if (deps.platform === 'win32') {
        return baseStatus('win32', configMode, {
          installed: false,
          enabled: false,
          running: false,
        });
      }

      if (deps.platform === 'linux') {
        if (!(await deps.hasSystemd())) {
          return baseStatus('unsupported', configMode, {
            installed: false,
            enabled: false,
            running: false,
            error: 'systemd is not available',
          });
        }
        if (!sessionBusAvailable(deps.env)) {
          return baseStatus('linux', configMode, {
            installed: false,
            enabled: false,
            running: false,
            error: 'no session bus',
          });
        }
        const unitPath = systemdUnitPath(deps.home);
        let unitBody = '';
        try {
          unitBody = await deps.readFile(unitPath);
        } catch {
          unitBody = '';
        }
        const installed = unitBody.length > 0;
        const enabled = installed
          ? (await runSystemctl(deps, ['--user', 'is-enabled', SYSTEMD_UNIT_BASENAME])).exitCode ===
            0
          : false;
        const active = installed
          ? await runSystemctl(deps, ['--user', 'is-active', SYSTEMD_UNIT_BASENAME])
          : { exitCode: 1, stdout: 'inactive', stderr: '' };
        const running = active.exitCode === 0;
        const linger = await readLingerEnabled(deps);
        const mode = installed ? (modeFromUnitBody(unitBody) ?? configMode) : configMode;
        return baseStatus('linux', mode, {
          installed,
          enabled,
          running,
          linger,
          execUsesCurrent: installed ? execStartUsesCurrent(unitBody, currentDir) : false,
          manager: {
            unitPath,
            label: SYSTEMD_UNIT_BASENAME,
            activeState: active.stdout.trim() || undefined,
          },
        });
      }

      if (deps.platform === 'darwin') {
        const plistPath = launchdPlistPath(deps.home);
        let plistBody = '';
        try {
          plistBody = await deps.readFile(plistPath);
        } catch {
          plistBody = '';
        }
        const installed = plistBody.length > 0;
        const print = installed
          ? await runLaunchctl(deps, ['print', `gui/${deps.uid}/${LAUNCHD_LABEL}`])
          : { exitCode: 1, stdout: '', stderr: '' };
        const running = print.exitCode === 0 && /state = running/i.test(print.stdout);
        const enabled = installed;
        const mode = installed ? (modeFromUnitBody(plistBody) ?? configMode) : configMode;
        return baseStatus('darwin', mode, {
          installed,
          enabled,
          running,
          execUsesCurrent: installed ? execStartUsesCurrent(plistBody, currentDir) : false,
          manager: {
            unitPath: plistPath,
            label: LAUNCHD_LABEL,
            activeState: running ? 'running' : installed ? 'loaded' : 'absent',
          },
        });
      }

      return baseStatus('unsupported', configMode, {
        installed: false,
        enabled: false,
        running: false,
        error: 'unsupported platform',
      });
    },
  };
}

function modeFromUnitBody(body: string): RuntimeServiceMode | null {
  const execStart = body.match(/^ExecStart=(.+)$/m)?.[1]?.trim();
  if (execStart?.endsWith(' connect')) return 'connect';
  if (execStart?.endsWith(' serve')) return 'serve';
  const args = [...body.matchAll(/<string>(connect|serve)<\/string>/g)].map((match) => match[1]);
  const last = args.at(-1);
  if (last === 'connect' || last === 'serve') return last;
  return null;
}

function inferConfiguredMode(config: RuntimeSlotState['config']): RuntimeServiceMode | null {
  if (config.hubUrl && !config.serveListen) return 'connect';
  if (config.serveListen && !config.hubUrl) return 'serve';
  return null;
}

function baseStatus(
  platform: RuntimeServiceStatus['platform'],
  mode: RuntimeServiceMode | null,
  rest: Omit<RuntimeServiceStatus, 'schemaVersion' | 'platform' | 'mode'>
): RuntimeServiceStatus {
  return { schemaVersion: 1, platform, mode, ...rest };
}

async function requireManagerCommand(
  deps: RuntimeServiceExecDeps,
  argv: readonly string[],
  label: string
): Promise<void> {
  const result = await deps.exec(argv, { env: deps.env });
  if (result.exitCode === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new RuntimeServiceManagementError(
    'runtime_service_unsupported',
    `${label} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`
  );
}

async function runSystemctl(
  deps: RuntimeServiceExecDeps,
  args: readonly string[]
): Promise<RuntimeServiceExecResult> {
  return await deps.exec(['systemctl', ...args], { env: deps.env });
}

async function runLaunchctl(
  deps: RuntimeServiceExecDeps,
  args: readonly string[]
): Promise<RuntimeServiceExecResult> {
  return await deps.exec(['launchctl', ...args], { env: deps.env });
}

export async function attemptEnableLinger(deps: RuntimeServiceExecDeps): Promise<void> {
  const result = await deps.exec(['loginctl', 'enable-linger', deps.user], { env: deps.env });
  if (result.exitCode === 0) return;
  const needsRoot =
    result.stderr.includes('Access denied') ||
    result.stderr.includes('not authorized') ||
    result.stderr.includes('Interactive authentication required');
  if (needsRoot) {
    process.stderr.write(
      `mangostudio-runtime: linger was not enabled (needs root). Run:\n  sudo loginctl enable-linger ${deps.user}\n`
    );
    return;
  }
  if (result.stderr.trim()) {
    process.stderr.write(`mangostudio-runtime: loginctl enable-linger: ${result.stderr.trim()}\n`);
  }
}

async function readLingerEnabled(deps: RuntimeServiceExecDeps): Promise<boolean | undefined> {
  const result = await deps.exec(['loginctl', 'show-user', deps.user, '-p', 'Linger'], {
    env: deps.env,
  });
  if (result.exitCode !== 0) return undefined;
  return /Linger=yes/i.test(result.stdout);
}

/** Whether doctor should inspect the user-level service for this health report. */
export function shouldCheckRuntimeService(report: {
  readonly slot: RuntimeSlot;
  readonly hubUrl?: string | null;
  readonly serveListen?: string | null;
}): boolean {
  if (report.slot !== 'remote') return false;
  return Boolean(report.hubUrl || report.serveListen);
}

export async function collectServiceDoctorDetails(env?: NodeJS.ProcessEnv): Promise<{
  readonly status: RuntimeServiceStatus;
  readonly currentBinaryPath: string;
}> {
  const manager = createRuntimeServiceManager(defaultRuntimeServiceExecDeps(env));
  const status = await manager.status();
  return { status, currentBinaryPath: currentBinaryForService(PAIRED_SLOT, env) };
}
