/**
 * Per-user service supervision for a long-running MangoStudio binary: systemd
 * user units on Linux, LaunchAgents on macOS, a per-user Scheduled Task on
 * Windows. The hub and the runtime both install through this one manager so a
 * fix to one supervisor's quirk reaches both binaries.
 *
 * Unit bodies are dumb string templates; every supervisor command goes through
 * an injected exec seam so tests never touch live systemd, launchd or
 * PowerShell.
 */

import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UserServicePlatform, UserServiceStatus } from '@mangostudio/shared/runtime-home';
import { RuntimeServiceManagementError } from '../errors';
import { HIDDEN_WINDOW } from './process-window';

const USER_SERVICE_NO_SYSTEMD_ERROR = 'systemd is not available';
const USER_SERVICE_UNSUPPORTED_PLATFORM_ERROR = 'unsupported platform';
/**
 * The single `status.error` that means "could not look", not "nothing is
 * there". Doctor branches on it, so it is a constant rather than a literal.
 */
export const USER_SERVICE_NO_SESSION_BUS_ERROR = 'no session bus';

export interface UserServiceExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface UserServiceExecDeps {
  readonly exec: (
    argv: readonly string[],
    options?: { readonly env?: NodeJS.ProcessEnv }
  ) => Promise<UserServiceExecResult>;
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
  /** Follows symlinks, so a dangling `current` reads as absent. */
  readonly pathExists: (path: string) => Promise<boolean>;
  /** Where non-fatal advice goes; defaults to stderr prefixed with the CLI name. */
  readonly warn?: (message: string) => void;
}

/** What a unit is called under each supervisor, and who to blame in messages. */
export interface UserServiceIdentity {
  /** systemd unit basename, `.service` included. */
  readonly unitName: string;
  /** launchd label, reverse-DNS. */
  readonly launchdLabel: string;
  /** Windows Scheduled Task name. */
  readonly taskName: string;
  /** The CLI that owns this unit, for hints such as `<cli> service install`. */
  readonly cliName: string;
  readonly docsUrl: string;
}

/** What the unit runs. Secrets never belong here: a unit file is world-readable. */
export interface UserServiceDefinition {
  readonly description: string;
  /** Program first, then its arguments; every element is one argv entry. */
  readonly argv: readonly string[];
  readonly workingDirectory?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Absolute file the supervisor appends stdout and stderr to. */
  readonly logFile?: string;
}

export interface UserServiceManager {
  install(definition: UserServiceDefinition): Promise<void>;
  uninstall(): Promise<void>;
  status(): Promise<UserServiceStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Asks the supervisor to bounce the unit and returns once the request is
   * accepted, not once the new process is up: a blocking wait would be killed
   * with the old process when the caller is the service itself.
   */
  restart(): Promise<void>;
  /** The installed unit body, or null when nothing is installed. */
  readUnit(): Promise<string | null>;
  /** Where the unit file lives on this platform; null for Windows. */
  readonly unitPath: string | null;
}

export function systemdUserUnitPath(home: string, unitName: string): string {
  return join(home, '.config', 'systemd', 'user', unitName);
}

function launchdAgentPlistPath(home: string, label: string): string {
  return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

export function renderSystemdUnitFile(definition: UserServiceDefinition): string {
  const execStart = definition.argv.map((arg) => escapeSystemdArg(arg)).join(' ');
  const service = [
    'Type=simple',
    `ExecStart=${execStart}`,
    ...(definition.workingDirectory
      ? [`WorkingDirectory=${escapeSystemdArg(definition.workingDirectory)}`]
      : []),
    ...Object.entries(definition.env ?? {}).map(
      ([key, value]) => `Environment=${escapeSystemdArg(`${key}=${value}`, true)}`
    ),
    ...(definition.logFile
      ? [
          `StandardOutput=append:${definition.logFile}`,
          `StandardError=append:${definition.logFile}`,
        ]
      : []),
    'Restart=on-failure',
    'RestartSec=5',
  ];
  return `[Unit]
Description=${definition.description}
After=network-online.target
Wants=network-online.target

[Service]
${service.join('\n')}

[Install]
WantedBy=default.target
`;
}

export function renderLaunchdPlistFile(label: string, definition: UserServiceDefinition): string {
  const programArgs = plistStringArray(definition.argv);
  const optional = [
    ...(definition.workingDirectory
      ? [
          `  <key>WorkingDirectory</key>\n  <string>${escapeXml(definition.workingDirectory)}</string>`,
        ]
      : []),
    ...(definition.env && Object.keys(definition.env).length > 0
      ? [
          `  <key>EnvironmentVariables</key>\n  <dict>\n${Object.entries(definition.env)
            .map(
              ([key, value]) =>
                `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`
            )
            .join('\n')}\n  </dict>`,
        ]
      : []),
    ...(definition.logFile
      ? [
          `  <key>StandardOutPath</key>\n  <string>${escapeXml(definition.logFile)}</string>`,
          `  <key>StandardErrorPath</key>\n  <string>${escapeXml(definition.logFile)}</string>`,
        ]
      : []),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
${optional.map((entry) => `${entry}\n`).join('')}  <key>RunAtLoad</key>
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

/**
 * The PowerShell that registers the Scheduled Task. The task runs a hidden
 * PowerShell that sets the unit's environment, moves to its working directory
 * and appends the program's output to the log file, since Task Scheduler
 * itself captures nothing.
 */
export function renderScheduledTaskInstallScript(
  taskName: string,
  definition: UserServiceDefinition
): string {
  const runner = renderScheduledTaskRunnerScript(definition);
  const runnerArgument = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(runner)}`;
  const action = [
    'New-ScheduledTaskAction',
    "-Execute 'powershell.exe'",
    `-Argument ${psQuote(runnerArgument)}`,
    ...(definition.workingDirectory
      ? [`-WorkingDirectory ${psQuote(definition.workingDirectory)}`]
      : []),
  ].join(' ');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$action = ${action}`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME',
    // A zero limit is "no limit"; the default of three days would stop the
    // server on the fourth.
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)',
    '$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited',
    `Register-ScheduledTask -TaskName ${psQuote(taskName)} -Description ${psQuote(definition.description)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${psQuote(taskName)}`,
  ].join('\n');
}

export function renderScheduledTaskRunnerScript(definition: UserServiceDefinition): string {
  const [program, ...args] = definition.argv;
  const invocation = `& ${psQuote(program ?? '')}${args.map((arg) => ` ${psQuote(arg)}`).join('')}`;
  return [
    ...Object.entries(definition.env ?? {}).map(
      ([key, value]) => `$env:${key} = ${psQuote(value)}`
    ),
    ...(definition.workingDirectory
      ? [`Set-Location ${psQuote(definition.workingDirectory)}`]
      : []),
    definition.logFile ? `${invocation} *>> ${psQuote(definition.logFile)}` : invocation,
  ].join('\n');
}

function renderScheduledTaskStatusScript(taskName: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$task = Get-ScheduledTask -TaskName ${psQuote(taskName)} -ErrorAction SilentlyContinue`,
    'if ($null -eq $task) { Write-Output \'{"installed":false}\'; exit 0 }',
    '$info = $task | Get-ScheduledTaskInfo',
    '$action = @($task.Actions)[0]',
    '@{ installed = $true; state = [string]$task.State; enabled = [bool]$task.Settings.Enabled; execute = [string]$action.Execute; arguments = [string]$action.Arguments; lastResult = [int]$info.LastTaskResult } | ConvertTo-Json -Compress',
  ].join('\n');
}

/** `Stop-ScheduledTask` and friends, one verb per call. */
function renderScheduledTaskVerbScript(
  verb: 'start' | 'stop' | 'unregister',
  taskName: string
): string {
  const name = psQuote(taskName);
  if (verb === 'start') {
    return `$ErrorActionPreference = 'Stop'\nStart-ScheduledTask -TaskName ${name}`;
  }
  if (verb === 'stop') {
    return `$ErrorActionPreference = 'Stop'\nStop-ScheduledTask -TaskName ${name}`;
  }
  return [
    "$ErrorActionPreference = 'Stop'",
    `Stop-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue`,
    `Unregister-ScheduledTask -TaskName ${name} -Confirm:$false`,
  ].join('\n');
}

/** Argv that runs a script through Windows PowerShell without shell quoting. */
function powershellArgv(script: string): string[] {
  return [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodePowerShell(script),
  ];
}

/** Inverse of `powershellArgv`'s encoding, for tests asserting on the script. */
export function decodePowerShellArgv(argv: readonly string[]): string | null {
  const index = argv.indexOf('-EncodedCommand');
  const encoded = index >= 0 ? argv[index + 1] : undefined;
  return encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : null;
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function escapeSystemdArg(value: string, force = false): string {
  if (force || /[\s"\\]/.test(value)) {
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  }
  return value;
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

/** The program a systemd or launchd unit body starts, or null when unreadable. */
export function execPathFromUnitBody(body: string): string | null {
  const execStart = body.match(/^ExecStart=(.+)$/m)?.[1]?.trim();
  if (execStart) return firstSystemdArg(execStart);
  const first = body.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/);
  return first?.[1] ? unescapeXml(first[1]) : null;
}

function firstSystemdArg(execStart: string): string {
  if (!execStart.startsWith('"')) return execStart.split(/\s+/)[0] ?? execStart;
  let out = '';
  for (let index = 1; index < execStart.length; index += 1) {
    const char = execStart[index];
    if (char === '\\' && index + 1 < execStart.length) {
      out += execStart[index + 1];
      index += 1;
      continue;
    }
    if (char === '"') break;
    out += char;
  }
  return out;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

export function defaultUserServiceExecDeps(
  env: NodeJS.ProcessEnv = process.env
): UserServiceExecDeps {
  return {
    exec: async (argv, options) => {
      const child = Bun.spawn([...argv], {
        env: { ...env, ...options?.env },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
        ...HIDDEN_WINDOW,
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
    user: env.USER ?? env.LOGNAME ?? env.USERNAME ?? 'user',
    hasSystemd: async () => {
      const result = await Bun.spawn(['which', 'systemctl'], {
        stdout: 'ignore',
        stderr: 'ignore',
        ...HIDDEN_WINDOW,
      }).exited;
      return result === 0;
    },
    writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
    readFile: (path) => readFile(path, 'utf8'),
    unlink: (path) => unlink(path),
    mkdir: (path) => mkdir(path, { recursive: true }).then(() => undefined),
    pathExists: (path) =>
      stat(path).then(
        () => true,
        () => false
      ),
  };
}

function sessionBusAvailable(env: NodeJS.ProcessEnv): boolean {
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  const dbus = env.DBUS_SESSION_BUS_ADDRESS?.trim();
  return Boolean(runtimeDir && runtimeDir.length > 0 && dbus && dbus.length > 0);
}

/** Creates the manager for one unit identity. // Usage: createUserServiceManager(identity).status() */
export function createUserServiceManager(
  identity: UserServiceIdentity,
  deps: UserServiceExecDeps = defaultUserServiceExecDeps()
): UserServiceManager {
  const warn =
    deps.warn ?? ((message: string) => process.stderr.write(`${identity.cliName}: ${message}\n`));

  const refuseUnsupported = (detail: string): never => {
    throw new RuntimeServiceManagementError(
      'runtime_service_unsupported',
      `${detail} See ${identity.docsUrl}`
    );
  };

  const refuseNoSessionBus = (): never => {
    throw new RuntimeServiceManagementError(
      'runtime_service_no_session_bus',
      [
        'No D-Bus session bus for systemd user services.',
        'Non-interactive SSH omits XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS.',
        `Try: XDG_RUNTIME_DIR=/run/user/${deps.uid} ${identity.cliName} service <command>`,
        `See ${identity.docsUrl}`,
      ].join('\n')
    );
  };

  const requireSystemd = async (): Promise<void> => {
    if (!sessionBusAvailable(deps.env)) refuseNoSessionBus();
    if (!(await deps.hasSystemd())) {
      refuseUnsupported('systemd user services are not available on this machine.');
    }
  };

  const unitPath =
    deps.platform === 'linux'
      ? systemdUserUnitPath(deps.home, identity.unitName)
      : deps.platform === 'darwin'
        ? launchdAgentPlistPath(deps.home, identity.launchdLabel)
        : null;

  const readUnit = async (): Promise<string | null> => {
    if (!unitPath) return null;
    try {
      const body = await deps.readFile(unitPath);
      return body.length > 0 ? body : null;
    } catch {
      return null;
    }
  };

  const linux = {
    async install(definition: UserServiceDefinition) {
      await requireSystemd();
      await deps.mkdir(join(deps.home, '.config', 'systemd', 'user'));
      await deps.writeFile(unitPath as string, renderSystemdUnitFile(definition));
      await requireCommand(['systemctl', '--user', 'daemon-reload'], 'systemctl daemon-reload');
      await requireCommand(
        ['systemctl', '--user', 'enable', '--now', identity.unitName],
        'systemctl enable --now'
      );
      await attemptEnableLinger(deps, warn);
    },
    async uninstall() {
      await requireSystemd();
      await run(['systemctl', '--user', 'disable', '--now', identity.unitName]);
      await deps.unlink(unitPath as string).catch(() => undefined);
      await run(['systemctl', '--user', 'daemon-reload']);
    },
    async status(): Promise<UserServiceStatus> {
      if (!(await deps.hasSystemd())) {
        return base('unsupported', identity.unitName, { error: USER_SERVICE_NO_SYSTEMD_ERROR });
      }
      if (!sessionBusAvailable(deps.env)) {
        return base('linux', identity.unitName, { error: USER_SERVICE_NO_SESSION_BUS_ERROR });
      }
      const body = await readUnit();
      const installed = body !== null;
      const enabled = installed
        ? (await run(['systemctl', '--user', 'is-enabled', identity.unitName])).exitCode === 0
        : false;
      const active = installed
        ? await run(['systemctl', '--user', 'is-active', identity.unitName])
        : { exitCode: 1, stdout: 'inactive', stderr: '' };
      const linger = await readLingerEnabled(deps);
      return base('linux', identity.unitName, {
        installed,
        enabled,
        running: active.exitCode === 0,
        linger,
        ...(body ? { execPath: execPathFromUnitBody(body) ?? undefined } : {}),
        manager: {
          unitPath: unitPath as string,
          label: identity.unitName,
          activeState: active.stdout.trim() || undefined,
        },
      });
    },
    start: () =>
      requireSystemd().then(() =>
        requireCommand(['systemctl', '--user', 'start', identity.unitName], 'systemctl start')
      ),
    stop: () =>
      requireSystemd().then(() =>
        requireCommand(['systemctl', '--user', 'stop', identity.unitName], 'systemctl stop')
      ),
    restart: () =>
      requireSystemd().then(() =>
        requireCommand(
          ['systemctl', '--user', '--no-block', 'restart', identity.unitName],
          'systemctl restart'
        )
      ),
  };

  const darwinTarget = `gui/${deps.uid}/${identity.launchdLabel}`;
  const darwin = {
    async install(definition: UserServiceDefinition) {
      await deps.mkdir(join(deps.home, 'Library', 'LaunchAgents'));
      await deps.writeFile(
        unitPath as string,
        renderLaunchdPlistFile(identity.launchdLabel, definition)
      );
      await run(['launchctl', 'bootout', darwinTarget]);
      await requireCommand(
        ['launchctl', 'bootstrap', `gui/${deps.uid}`, unitPath as string],
        'launchctl bootstrap'
      );
      await requireCommand(['launchctl', 'kickstart', '-k', darwinTarget], 'launchctl kickstart');
    },
    async uninstall() {
      await run(['launchctl', 'bootout', darwinTarget]);
      await deps.unlink(unitPath as string).catch(() => undefined);
    },
    async status(): Promise<UserServiceStatus> {
      const body = await readUnit();
      const installed = body !== null;
      const print = installed
        ? await run(['launchctl', 'print', darwinTarget])
        : { exitCode: 1, stdout: '', stderr: '' };
      const running = print.exitCode === 0 && /state = running/i.test(print.stdout);
      return base('darwin', identity.launchdLabel, {
        installed,
        enabled: installed,
        running,
        ...(body ? { execPath: execPathFromUnitBody(body) ?? undefined } : {}),
        manager: {
          unitPath: unitPath as string,
          label: identity.launchdLabel,
          activeState: running ? 'running' : installed ? 'loaded' : 'absent',
        },
      });
    },
    start: () => requireCommand(['launchctl', 'kickstart', darwinTarget], 'launchctl kickstart'),
    stop: () => requireCommand(['launchctl', 'kill', 'TERM', darwinTarget], 'launchctl kill'),
    restart: () =>
      requireCommand(['launchctl', 'kickstart', '-k', darwinTarget], 'launchctl kickstart'),
  };

  const win32 = {
    install: (definition: UserServiceDefinition) =>
      requireCommand(
        powershellArgv(renderScheduledTaskInstallScript(identity.taskName, definition)),
        'Register-ScheduledTask'
      ),
    uninstall: () =>
      requireCommand(
        powershellArgv(renderScheduledTaskVerbScript('unregister', identity.taskName)),
        'Unregister-ScheduledTask'
      ),
    async status(): Promise<UserServiceStatus> {
      const result = await run(powershellArgv(renderScheduledTaskStatusScript(identity.taskName)));
      if (result.exitCode !== 0) {
        return base('win32', identity.taskName, {
          error: result.stderr.trim() || result.stdout.trim() || 'Get-ScheduledTask failed',
        });
      }
      const task = parseScheduledTaskJson(result.stdout);
      if (!task) {
        return base('win32', identity.taskName, { error: 'Get-ScheduledTask printed no JSON' });
      }
      return base('win32', identity.taskName, {
        installed: task.installed,
        enabled: task.installed && task.enabled,
        running: task.installed && task.state === 'Running',
        ...(task.execute ? { execPath: task.execute } : {}),
        manager: {
          label: identity.taskName,
          activeState: task.installed ? task.state : 'absent',
        },
      });
    },
    start: () =>
      requireCommand(
        powershellArgv(renderScheduledTaskVerbScript('start', identity.taskName)),
        'Start-ScheduledTask'
      ),
    stop: () =>
      requireCommand(
        powershellArgv(renderScheduledTaskVerbScript('stop', identity.taskName)),
        'Stop-ScheduledTask'
      ),
    async restart() {
      await run(powershellArgv(renderScheduledTaskVerbScript('stop', identity.taskName)));
      await requireCommand(
        powershellArgv(renderScheduledTaskVerbScript('start', identity.taskName)),
        'Start-ScheduledTask'
      );
    },
  };

  const backend = () => {
    if (deps.platform === 'linux') return linux;
    if (deps.platform === 'darwin') return darwin;
    if (deps.platform === 'win32') return win32;
    return null;
  };

  const require = () => {
    const chosen = backend();
    if (chosen) return chosen;
    return refuseUnsupported('No user-level service manager is supported on this platform.');
  };

  async function run(argv: readonly string[]): Promise<UserServiceExecResult> {
    return await deps.exec(argv, { env: deps.env });
  }

  async function requireCommand(argv: readonly string[], label: string): Promise<void> {
    const result = await run(argv);
    if (result.exitCode === 0) return;
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new RuntimeServiceManagementError(
      'runtime_service_unsupported',
      `${label} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`
    );
  }

  return {
    unitPath,
    readUnit,
    install: async (definition) => await require().install(definition),
    uninstall: async () => await require().uninstall(),
    status: async () => {
      const chosen = backend();
      if (chosen) return await chosen.status();
      return base('unsupported', identity.unitName, {
        error: USER_SERVICE_UNSUPPORTED_PLATFORM_ERROR,
      });
    },
    start: async () => await require().start(),
    stop: async () => await require().stop(),
    restart: async () => await require().restart(),
  };
}

function base(
  platform: UserServicePlatform,
  unitName: string,
  rest: Partial<Omit<UserServiceStatus, 'schemaVersion' | 'platform' | 'unitName'>>
): UserServiceStatus {
  return {
    schemaVersion: 1,
    platform,
    unitName,
    installed: false,
    enabled: false,
    running: false,
    ...rest,
  };
}

interface ScheduledTaskJson {
  readonly installed: boolean;
  readonly state: string;
  readonly enabled: boolean;
  readonly execute: string | null;
}

/** Windows PowerShell 5.1 serialises the state enum as a number; PowerShell 7 as a name. */
const SCHEDULED_TASK_STATES: Record<number, string> = {
  0: 'Unknown',
  1: 'Disabled',
  2: 'Queued',
  3: 'Ready',
  4: 'Running',
};

export function parseScheduledTaskJson(stdout: string): ScheduledTaskJson | null {
  const line = stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('{'));
  if (!line) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (record.installed !== true)
    return { installed: false, state: 'absent', enabled: false, execute: null };
  const state =
    typeof record.state === 'number'
      ? (SCHEDULED_TASK_STATES[record.state] ?? 'Unknown')
      : String(record.state ?? 'Unknown');
  return {
    installed: true,
    state,
    enabled: record.enabled !== false,
    execute: typeof record.execute === 'string' && record.execute ? record.execute : null,
  };
}

export async function attemptEnableLinger(
  deps: UserServiceExecDeps,
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`)
): Promise<void> {
  const result = await deps.exec(['loginctl', 'enable-linger', deps.user], { env: deps.env });
  if (result.exitCode === 0) return;
  const needsRoot =
    result.stderr.includes('Access denied') ||
    result.stderr.includes('not authorized') ||
    result.stderr.includes('Interactive authentication required');
  if (needsRoot) {
    warn(`linger was not enabled (needs root). Run:\n  sudo loginctl enable-linger ${deps.user}`);
    return;
  }
  if (result.stderr.trim()) {
    warn(`loginctl enable-linger: ${result.stderr.trim()}`);
  }
}

async function readLingerEnabled(deps: UserServiceExecDeps): Promise<boolean | undefined> {
  const result = await deps.exec(['loginctl', 'show-user', deps.user, '-p', 'Linger'], {
    env: deps.env,
  });
  if (result.exitCode !== 0) return undefined;
  return /Linger=yes/i.test(result.stdout);
}
