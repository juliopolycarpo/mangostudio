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
  const execStart = definition.argv
    .map((arg) => escapeSystemdArg(arg, { execStart: true }))
    .join(' ');
  const service = [
    'Type=simple',
    `ExecStart=${execStart}`,
    ...(definition.workingDirectory
      ? [`WorkingDirectory=${escapeSystemdArg(definition.workingDirectory)}`]
      : []),
    ...Object.entries(definition.env ?? {}).map(([key, value]) => {
      assertSingleLine(key, value);
      return `Environment=${escapeSystemdArg(`${key}=${value}`, { force: true })}`;
    }),
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
 * What Task Scheduler accepts in an action's argument string. The whole runner
 * script lives in there base64-encoded, and the encoding is not free: UTF-16
 * doubles the script and base64 adds a third again, so roughly 2.7 bytes of
 * argument per character of script.
 */
const SCHEDULED_TASK_ARGUMENT_MAX = 8_192;

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
  // Task Scheduler cuts an over-long argument rather than refusing it, and a
  // cut base64 blob decodes to a truncated script — a task that registers, is
  // reported installed, and starts a hub with half its environment or none of
  // its program. Say so here instead.
  if (runnerArgument.length > SCHEDULED_TASK_ARGUMENT_MAX) {
    throw new Error(
      `The Scheduled Task command for ${taskName} is ${runnerArgument.length} characters, over the ${SCHEDULED_TASK_ARGUMENT_MAX} Task Scheduler accepts. Move configuration out of the environment into config.toml so the unit does not have to carry it.`
    );
  }
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
    // Windows PowerShell's own redirection writes UTF-16; `logs` and the page
    // read the file as UTF-8, so the pipeline sets the encoding explicitly.
    definition.logFile
      ? `${invocation} 2>&1 | Out-File -Append -Encoding utf8 -FilePath ${psQuote(definition.logFile)}`
      : invocation,
    // The pipeline's own status is `Out-File`'s, which succeeds whatever the
    // program did, and a PowerShell that ends normally exits 0. Task Scheduler
    // would read every crash as a clean run and never spend the RestartCount
    // above, leaving the hub down until the next logon. `$LASTEXITCODE` is the
    // native invocation's, and survives the pipeline.
    'exit $LASTEXITCODE',
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
  // Stop first, unlike the other backends: unregistering leaves a running
  // instance alive, and stopping a task that no longer exists fails. A task
  // removing itself from inside is refused upstream, so the stop never ends
  // the caller here.
  return [
    "$ErrorActionPreference = 'Stop'",
    `Stop-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue`,
    `Unregister-ScheduledTask -TaskName ${name} -Confirm:$false`,
  ].join('\n');
}

/**
 * Stop, wait for the instance to actually end, then start. Task Scheduler's
 * stop is asynchronous and the task ignores new instances while one is
 * running, so a start issued too early would be dropped with exit 0.
 */
function renderScheduledTaskRestartScript(taskName: string): string {
  const name = psQuote(taskName);
  return [
    "$ErrorActionPreference = 'Stop'",
    `Stop-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue`,
    '$deadline = (Get-Date).AddSeconds(15)',
    `while (((Get-ScheduledTask -TaskName ${name}).State -eq 'Running') -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 250 }`,
    `Start-ScheduledTask -TaskName ${name}`,
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

/**
 * One argument for a systemd directive. `%` is a specifier and `$` an
 * expansion in `ExecStart`, so both are doubled; `Environment=` values keep
 * their `$` since systemd does not expand it there.
 */
function escapeSystemdArg(
  value: string,
  options: { force?: boolean; execStart?: boolean } = {}
): string {
  const specifiers = options.execStart
    ? value.replaceAll('%', '%%').replaceAll('$', '$$$$')
    : value.replaceAll('%', '%%');
  if (options.force || /[\s"\\]/.test(specifiers)) {
    return `"${specifiers.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  }
  return specifiers;
}

/** A unit file is line-oriented; a value with a line break cannot be represented. */
function assertSingleLine(key: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new RuntimeServiceManagementError(
      'runtime_service_unsupported',
      `Environment value for ${key} contains a line break, which a unit file cannot carry.`
    );
  }
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
    // A unit carries the environment it runs with; nobody else on the machine
    // needs to read it.
    writeFile: (path, contents) => writeFile(path, contents, { encoding: 'utf8', mode: 0o600 }),
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

/**
 * The env systemctl needs to reach the user manager. A hub started with
 * `serve -d` or by a unit does not carry the two variables a login shell
 * has, so when they are missing they are derived from the uid — the same
 * derivation the SSH bootstrap uses — and accepted only if the bus socket is
 * actually there. Null means there is no session bus to talk to.
 */
async function sessionBusEnv(deps: UserServiceExecDeps): Promise<NodeJS.ProcessEnv | null> {
  const runtimeDir = deps.env.XDG_RUNTIME_DIR?.trim() || `/run/user/${deps.uid}`;
  const dbus = deps.env.DBUS_SESSION_BUS_ADDRESS?.trim() || `unix:path=${runtimeDir}/bus`;
  if (!(await deps.pathExists(`${runtimeDir}/bus`))) return null;
  return { ...deps.env, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: dbus };
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

  // Resolved once per manager: every systemctl call carries the same env.
  let busEnv: NodeJS.ProcessEnv | null | undefined;
  const sessionBus = async (): Promise<NodeJS.ProcessEnv | null> => {
    if (busEnv === undefined) busEnv = await sessionBusEnv(deps);
    return busEnv;
  };

  const requireSystemd = async (): Promise<void> => {
    if ((await sessionBus()) === null) refuseNoSessionBus();
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
    // The stop comes last on every platform: when the caller is the service
    // itself, stopping ends the process, and whatever was queued after it
    // never runs. Removing the file first means a unit that outlives this
    // call still reads as gone.
    async uninstall() {
      await requireSystemd();
      await run(['systemctl', '--user', 'disable', identity.unitName]);
      await deps.unlink(unitPath as string).catch(() => undefined);
      await run(['systemctl', '--user', 'daemon-reload']);
      await run(['systemctl', '--user', '--no-block', 'stop', identity.unitName]);
    },
    async status(): Promise<UserServiceStatus> {
      if (!(await deps.hasSystemd())) {
        return base('unsupported', identity.unitName, { error: USER_SERVICE_NO_SYSTEMD_ERROR });
      }
      if ((await sessionBus()) === null) {
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
      await deps.unlink(unitPath as string).catch(() => undefined);
      await run(['launchctl', 'bootout', darwinTarget]);
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
    // A stopped job is one that has left the domain, not one that was signalled:
    // the plist sets `KeepAlive.SuccessfulExit` false, and a process ended by a
    // signal did not exit successfully, so launchd brought it straight back
    // after `ThrottleInterval` while the caller was told it had stopped. The
    // plist stays on disk either way, so the job still loads at the next login
    // — the same thing `systemctl --user stop` leaves behind.
    async start() {
      // Tolerated: the job is already in the domain whenever it was never
      // stopped, and `bootstrap` treats that as an error.
      await run(['launchctl', 'bootstrap', `gui/${deps.uid}`, unitPath as string]);
      await requireCommand(['launchctl', 'kickstart', darwinTarget], 'launchctl kickstart');
    },
    async stop() {
      const result = await run(['launchctl', 'bootout', darwinTarget]);
      if (result.exitCode === 0) return;
      // `bootout` also fails when there is nothing to boot out, which is the
      // state `stop` was asked to reach. Only a job still in the domain is one
      // this failed to stop.
      if ((await run(['launchctl', 'print', darwinTarget])).exitCode !== 0) return;
      const detail = result.stderr.trim() || result.stdout.trim();
      throw new RuntimeServiceManagementError(
        'runtime_service_unsupported',
        `launchctl bootout failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`
      );
    },
    // `-k` signals the job and lets launchd start it again, which is a restart
    // rather than a stop, so KeepAlive is working with it here.
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
      const execPath = task.execute ? programFromTaskAction(task.execute, task.arguments) : null;
      return base('win32', identity.taskName, {
        installed: task.installed,
        enabled: task.installed && task.enabled,
        running: task.installed && task.state === 'Running',
        ...(execPath ? { execPath } : {}),
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
    restart: () =>
      requireCommand(
        powershellArgv(renderScheduledTaskRestartScript(identity.taskName)),
        'Stop-ScheduledTask/Start-ScheduledTask'
      ),
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
    const env = argv[0] === 'systemctl' ? ((await sessionBus()) ?? deps.env) : deps.env;
    return await deps.exec(argv, { env });
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
  readonly arguments: string | null;
}

/**
 * The program behind the task's hidden PowerShell wrapper, read back out of
 * the encoded runner script; the wrapper itself when the task is not ours.
 */
export function programFromTaskAction(execute: string, args: string | null): string {
  const encoded = args?.match(/-EncodedCommand\s+(\S+)/)?.[1];
  if (!encoded) return execute;
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  const program = script.match(/^& '((?:[^']|'')*)'/m)?.[1];
  return program ? program.replaceAll("''", "'") : execute;
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
  if (record.installed !== true) {
    return { installed: false, state: 'absent', enabled: false, execute: null, arguments: null };
  }
  const state =
    typeof record.state === 'number'
      ? (SCHEDULED_TASK_STATES[record.state] ?? 'Unknown')
      : String(record.state ?? 'Unknown');
  return {
    installed: true,
    state,
    enabled: record.enabled !== false,
    execute: typeof record.execute === 'string' && record.execute ? record.execute : null,
    arguments: typeof record.arguments === 'string' && record.arguments ? record.arguments : null,
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
