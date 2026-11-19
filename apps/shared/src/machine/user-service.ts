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

import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { posix } from 'node:path';

import { HIDDEN_WINDOW } from '../process';
import { RuntimeServiceManagementError } from '../runtime-contract/service-errors';
import type { UserServicePlatform, UserServiceStatus } from '../runtime-home';

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
  /** Waits between `launchctl bootstrap` retries; defaults to a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
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

/**
 * Which half of {@link UserServiceManager.restartRetargeted} failed. `rewrite`
 * is everything up to the supervisor reading the new definition: the unit is
 * as it was. `restart` is the bounce after it: the unit already names the new
 * program.
 */
export type RestartRetargetedPhase = 'rewrite' | 'restart';

/**
 * A failed {@link UserServiceManager.restartRetargeted}, naming the phase. A
 * caller that wants the unit up as installed after a failed rewrite must not do
 * the same after a failed restart: the unit is already moved, and a second
 * restart would run into whatever the first one hit.
 * // Usage: if (error instanceof RestartRetargetedError && error.phase === 'restart') throw error
 */
export class RestartRetargetedError extends RuntimeServiceManagementError {
  readonly phase: RestartRetargetedPhase;
  /** Whether the unit on disk (or in Task Scheduler) was repointed before the failure. */
  readonly unitMoved: boolean;
  /** The underlying message, without the phase wording around it. */
  readonly reason: string;
  override readonly cause: unknown;

  constructor(input: {
    readonly phase: RestartRetargetedPhase;
    readonly program: string;
    readonly unitMoved: boolean;
    readonly cause: unknown;
  }) {
    const reason = input.cause instanceof Error ? input.cause.message : String(input.cause);
    super(
      'runtime_service_unsupported',
      input.phase === 'rewrite'
        ? `Could not move the service unit onto ${input.program}: ${reason}`
        : input.unitMoved
          ? `The service unit was updated to run ${input.program}, but restarting it failed: ${reason}`
          : `Restarting the service unit failed: ${reason}`,
      { phase: input.phase, program: input.program }
    );
    this.name = 'RestartRetargetedError';
    this.phase = input.phase;
    this.unitMoved = input.unitMoved;
    this.reason = reason;
    this.cause = input.cause;
  }
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
  /**
   * Restart the unit onto `program`: point an installed unit at it, keeping its
   * arguments, environment, working directory and log file as they are, and
   * bring it up from that definition. Returns whether the unit was repointed;
   * false when nothing is installed or it already runs `program`, in which
   * case this is a plain `restart()`.
   *
   * One operation rather than a retarget followed by `restart()` because on
   * launchd the loaded job only rereads its plist across a bootout and a
   * bootstrap, and a bootstrap that is allowed to fail there leaves the job
   * unloaded. A failure is a {@link RestartRetargetedError} naming the phase:
   * a failed `rewrite` leaves the unit as it was, a failed `restart` leaves the
   * rewritten definition in place (`start()` still brings the unit up from it).
   * Like `restart()`, a caller that is the service itself is stopped partway on
   * launchd, so it must run this from a process outside the unit.
   */
  restartRetargeted(program: string): Promise<boolean>;
  /** The installed unit body, or null when nothing is installed. */
  readUnit(): Promise<string | null>;
  /** Where the unit file lives on this platform; null for Windows. */
  readonly unitPath: string | null;
}

/**
 * The verbs a manager answers to, in the order a CLI should list them. Both
 * the hub's `service` command and the runtime's parse against this, so adding
 * a verb to {@link UserServiceManager} cannot leave either CLI rejecting it.
 */
export const USER_SERVICE_ACTIONS = [
  'install',
  'uninstall',
  'status',
  'start',
  'stop',
  'restart',
] as const;
export type UserServiceAction = (typeof USER_SERVICE_ACTIONS)[number];

/** // Usage: isUserServiceAction('start') // → true */
export function isUserServiceAction(value: string | undefined): value is UserServiceAction {
  return (USER_SERVICE_ACTIONS as readonly string[]).includes(value ?? '');
}

/**
 * Resolves a systemd user unit in the Linux host's POSIX path layout.
 * // Usage: systemdUserUnitPath('/home/me', 'example.service')
 */
export function systemdUserUnitPath(home: string, unitName: string): string {
  return posix.join(home, '.config', 'systemd', 'user', unitName);
}

function launchdAgentPlistPath(home: string, label: string): string {
  return posix.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
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

/** Waits between `launchctl bootstrap` attempts: five tries over about four seconds. */
const LAUNCHD_BOOTSTRAP_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000];

/** launchctl exit codes for a job that is exiting: 5 is EIO, 37 is "operation already in progress". */
const LAUNCHD_TRANSIENT_EXIT_CODES: readonly number[] = [5, 37];

/** The encoded runner script inside a task's action arguments. */
const TASK_ENCODED_COMMAND = /-EncodedCommand\s+(\S+)/;
/**
 * The runner script's program line: the first one that opens with `& '`. The
 * environment and working directory lines before it start with `$env:` and
 * `Set-Location`.
 */
const RUNNER_PROGRAM_LINE = /^& '(?:[^']|'')*'/m;

/**
 * Task Scheduler cuts an over-long argument rather than refusing it, and a
 * cut base64 blob decodes to a truncated script — a task that registers, is
 * reported installed, and starts a hub with half its environment or none of
 * its program. Say so here instead.
 */
function assertTaskArgumentFits(taskName: string, runnerArgument: string): void {
  if (runnerArgument.length <= SCHEDULED_TASK_ARGUMENT_MAX) return;
  // The same refusal shape every other backend raises, so `withServiceErrors`
  // prints it as one line and the machine route answers 409 — a bare `Error`
  // reached the user as a stack trace and the page as a 500.
  throw new RuntimeServiceManagementError(
    'runtime_service_unsupported',
    `The Scheduled Task command for ${taskName} is ${runnerArgument.length} characters, over the ${SCHEDULED_TASK_ARGUMENT_MAX} Task Scheduler accepts. Move configuration out of the environment into config.toml so the unit does not have to carry it.`
  );
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
  assertTaskArgumentFits(taskName, runnerArgument);
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
    //
    // It is unset when the program never ran at all — a missing or unreadable
    // executable after an upgrade — and `exit $null` is `exit 0`, which is the
    // same lie by a different route. Name that as a failure so the task retries.
    'if ($null -eq $LASTEXITCODE) { exit 1 }',
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

/**
 * The task's action arguments with the program inside the encoded runner
 * script swapped for `program`; null when it already runs it. The decode,
 * rewrite and re-encode happen here rather than in PowerShell so the transform
 * is ordinary code under test, and the script that follows only stores the
 * result. Throws when the task does not carry an encoded runner script (not
 * ours to rewrite) or when the new argument would exceed what Task Scheduler
 * keeps.
 * // Usage: retargetScheduledTaskArguments(taskName, status.arguments, launcherPath)
 */
export function retargetScheduledTaskArguments(
  taskName: string,
  taskArguments: string,
  program: string
): string | null {
  const encoded = TASK_ENCODED_COMMAND.exec(taskArguments)?.[1];
  if (!encoded) {
    throw new RuntimeServiceManagementError(
      'runtime_service_unsupported',
      `The Scheduled Task ${taskName} does not run an encoded runner script; install it again.`
    );
  }
  const runner = Buffer.from(encoded, 'base64').toString('utf16le');
  // The callback form: a string replacement would read `$&` or `$1` in the path.
  // Without the `g` flag only the first program line is replaced.
  const updatedRunner = runner.replace(RUNNER_PROGRAM_LINE, () => `& ${psQuote(program)}`);
  if (updatedRunner === runner) return null;
  const updated = taskArguments.replace(
    TASK_ENCODED_COMMAND,
    () => `-EncodedCommand ${encodePowerShell(updatedRunner)}`
  );
  assertTaskArgumentFits(taskName, updated);
  return updated;
}

/** Stores `taskArguments` as the task's action arguments, leaving trigger, settings and the rest of the action as they are. */
function renderScheduledTaskSetArgumentsScript(taskName: string, taskArguments: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$task = Get-ScheduledTask -TaskName ${psQuote(taskName)}`,
    '$action = @($task.Actions)[0]',
    `$action.Arguments = ${psQuote(taskArguments)}`,
    `Set-ScheduledTask -TaskName ${psQuote(taskName)} -Action $action | Out-Null`,
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
  return splitSystemdProgram(execStart).program;
}

/**
 * What an `ExecStart` value starts. `prefix` is the run of execution modifiers
 * systemd reads before the path (`-` ignore failure, `@` argv[0] override, `:`
 * no expansion, `+` and `!` privileges); they are not part of the program.
 * `rest` is the text after the program, arguments included.
 */
function splitSystemdProgram(execStart: string): {
  prefix: string;
  program: string;
  rest: string;
} {
  const prefix = /^[-@:+!]*/.exec(execStart)?.[0] ?? '';
  const command = execStart.slice(prefix.length);
  if (!command.startsWith('"')) {
    const program = command.split(/\s+/)[0] ?? command;
    return { prefix, program, rest: command.slice(program.length) };
  }
  let out = '';
  let index = 1;
  for (; index < command.length; index += 1) {
    const char = command[index];
    if (char === '\\' && index + 1 < command.length) {
      out += command[index + 1];
      index += 1;
      continue;
    }
    if (char === '"') break;
    out += char;
  }
  return { prefix, program: out, rest: command.slice(index + 1) };
}

/**
 * The unit body with the program it starts replaced and everything else kept
 * byte for byte, or null when the body names no program this can find.
 * // Usage: replaceUnitProgram(body, '/opt/homebrew/bin/mangostudio')
 */
export function replaceUnitProgram(body: string, program: string): string | null {
  const execStart = /^ExecStart=(.+)$/m.exec(body);
  if (execStart?.[1]) {
    const { prefix, rest } = splitSystemdProgram(execStart[1].trim());
    const line = `ExecStart=${prefix}${escapeSystemdArg(program, { execStart: true })}${rest}`;
    return (
      body.slice(0, execStart.index) + line + body.slice(execStart.index + execStart[0].length)
    );
  }
  const plist = /(<key>ProgramArguments<\/key>\s*<array>\s*<string>)[^<]*(<\/string>)/.exec(body);
  if (plist?.[1] && plist[2]) {
    const replacement = `${plist[1]}${escapeXml(program)}${plist[2]}`;
    return body.slice(0, plist.index) + replacement + body.slice(plist.index + plist[0].length);
  }
  return null;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

/**
 * Who `loginctl` is asked about. `USER` and `LOGNAME` are login-shell variables:
 * a hub started with `serve -d` or by a unit carries neither, and falling back
 * to a placeholder made `enable-linger` fail silently — the page reported an
 * installed service that would die at the next logout. The account this process
 * actually runs as is the answer; the environment is only the fallback for a
 * platform where `userInfo` cannot say.
 * // Usage: currentUserName(process.env) // → "juliopolycarpo"
 */
export function currentUserName(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const name = userInfo().username.trim();
    if (name) return name;
  } catch {
    // No passwd entry for this uid (a scratch container); fall through.
  }
  return env.USER ?? env.LOGNAME ?? env.USERNAME ?? 'user';
}

export function defaultUserServiceExecDeps(
  env: NodeJS.ProcessEnv = process.env
): UserServiceExecDeps {
  return {
    exec: async (argv, options) => {
      // A supervisor command that is not on PATH is an ordinary failure with a
      // message, not an exception. `Bun.spawn` throws for a missing program,
      // and every caller here reads an exit code: letting the throw out turns
      // one absent `loginctl` into a rejected `status()`, which is a 500 on
      // `GET /api/machine/status` and a stack trace out of `service status`.
      let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
      try {
        child = Bun.spawn([...argv], {
          env: { ...env, ...options?.env },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: 30_000,
          ...HIDDEN_WINDOW,
        });
      } catch (error) {
        // 127 is the shell's own "command not found", which is what this is.
        return {
          exitCode: 127,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
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
    user: currentUserName(env),
    // A PATH lookup rather than a spawned `which`: the answer is the same, it
    // costs no process, and `which` is itself absent from enough container
    // images that spawning it threw ENOENT on the machines this most needed to
    // answer for.
    hasSystemd: () => Promise.resolve(Bun.which('systemctl', { PATH: env.PATH }) !== null),
    // A unit carries the environment it runs with; nobody else on the machine
    // needs to read it.
    writeFile: async (path, contents) => {
      await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
      // `mode` is honoured only when the file is created, so a reinstall over a
      // unit an older build left at 0644 would keep it — and that unit carries
      // this hub's configuration.
      await chmod(path, 0o600);
    },
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

  // Resolved once per manager, but only once it resolves: every systemctl call
  // carries the same env. A *missing* bus is not cached, unlike `hasSystemd`
  // below — the socket appears the moment the user opens a session, and the
  // hub's manager lives for the whole process. Caching the absence would leave
  // a `serve -d` started over SSH reporting `no-session-bus` and refusing
  // `service install` for the rest of its life, long after the desktop login
  // that created the bus.
  let busEnv: NodeJS.ProcessEnv | null = null;
  const sessionBus = async (): Promise<NodeJS.ProcessEnv | null> => {
    if (busEnv) return busEnv;
    busEnv = await sessionBusEnv(deps);
    return busEnv;
  };

  // Also resolved once: `status()` is polled by the machine page, and probing
  // for systemctl on every poll spawns a process to re-answer a question about
  // the machine that cannot change while this one runs.
  let systemdPresent: boolean | undefined;
  const hasSystemd = async (): Promise<boolean> => {
    if (systemdPresent === undefined) systemdPresent = await deps.hasSystemd();
    return systemdPresent;
  };

  const requireSystemd = async (): Promise<void> => {
    // Systemd first: on a machine that has none, "export XDG_RUNTIME_DIR and
    // try again" is advice that cannot work, and it is what the bus check says.
    if (!(await hasSystemd())) {
      refuseUnsupported('systemd user services are not available on this machine.');
    }
    if ((await sessionBus()) === null) refuseNoSessionBus();
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

  /** The unit body pointed at `program`, or null when nothing is installed or it already runs it. */
  const retargetedUnitBody = async (program: string): Promise<string | null> => {
    const body = await readUnit();
    if (body === null) return null;
    const updated = replaceUnitProgram(body, program);
    if (updated === null) {
      throw new RuntimeServiceManagementError(
        'runtime_service_unsupported',
        `The unit at ${unitPath} names no program to retarget; install it again.`
      );
    }
    return updated === body ? null : updated;
  };

  const restartSystemd = (): Promise<void> =>
    requireSystemd().then(() =>
      requireCommand(
        ['systemctl', '--user', '--no-block', 'restart', identity.unitName],
        'systemctl restart'
      )
    );

  const linux = {
    async install(definition: UserServiceDefinition) {
      await requireSystemd();
      await deps.mkdir(posix.join(deps.home, '.config', 'systemd', 'user'));
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
      if (!(await hasSystemd())) {
        return base('unsupported', identity.unitName, {
          error: USER_SERVICE_NO_SYSTEMD_ERROR,
          errorCode: 'no-systemd',
        });
      }
      if ((await sessionBus()) === null) {
        return base('linux', identity.unitName, {
          error: USER_SERVICE_NO_SESSION_BUS_ERROR,
          errorCode: 'no-session-bus',
        });
      }
      const body = await readUnit();
      const installed = body !== null;
      // Three independent processes. `status()` is polled every 2s through an
      // action window, so they are spawned together rather than in turn — the
      // same reason `hasSystemd` is memoised.
      const [enabledResult, active, linger] = await Promise.all([
        installed ? run(['systemctl', '--user', 'is-enabled', identity.unitName]) : null,
        installed
          ? run(['systemctl', '--user', 'is-active', identity.unitName])
          : { exitCode: 1, stdout: 'inactive', stderr: '' },
        readLingerEnabled(deps),
      ]);
      const enabled = enabledResult?.exitCode === 0;
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
    restart: restartSystemd,
    async restartRetargeted(program: string) {
      await requireSystemd();
      const moved = await retargetPhase('rewrite', program, false, async () => {
        const updated = await retargetedUnitBody(program);
        if (updated === null) return false;
        await deps.writeFile(unitPath as string, updated);
        // The running process keeps the old program until the restart; systemd
        // must reread the file first or that restart reuses the old one.
        await requireCommand(['systemctl', '--user', 'daemon-reload'], 'systemctl daemon-reload');
        return true;
      });
      await retargetPhase('restart', program, moved, restartSystemd);
      return moved;
    },
  };

  const darwinTarget = `gui/${deps.uid}/${identity.launchdLabel}`;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  /** Whether launchd still has the job in its domain, running or on its way out. */
  const darwinJobLoaded = async (): Promise<boolean> =>
    (await run(['launchctl', 'print', darwinTarget])).exitCode === 0;
  /**
   * Take the job out of the domain. A failure is only a failure while the job
   * is still there: `bootout` also fails when there is nothing to remove, which
   * is the state asked for. Error 5 and 37 mean the job is already on its way
   * out, so that one is waited for (bounded) instead of raced.
   */
  const darwinBootout = async (): Promise<void> => {
    const result = await run(['launchctl', 'bootout', darwinTarget]);
    if (result.exitCode === 0 || !(await darwinJobLoaded())) return;
    if (!LAUNCHD_TRANSIENT_EXIT_CODES.includes(result.exitCode)) {
      throw commandFailure('launchctl bootout', result);
    }
    for (const delay of LAUNCHD_BOOTSTRAP_RETRY_DELAYS_MS) {
      await sleep(delay);
      if (!(await darwinJobLoaded())) return;
    }
    throw commandFailure('launchctl bootout', result);
  };
  /**
   * Load the plist, which must not fail: a job that is not in the domain after
   * this is not running and will not come back. Right after a `bootout` the
   * bootstrap answers error 5 (EIO) or 37 while the old job is still exiting,
   * so those are retried with a growing, bounded wait — but only while
   * `launchctl print` still lists the job. The same codes answer a bootstrap
   * that failed for another reason, and waiting does not help that one.
   */
  const darwinBootstrapRequired = async (): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      const result = await run(['launchctl', 'bootstrap', `gui/${deps.uid}`, unitPath as string]);
      if (result.exitCode === 0) return;
      const delay = LAUNCHD_BOOTSTRAP_RETRY_DELAYS_MS[attempt];
      const retry =
        delay !== undefined &&
        LAUNCHD_TRANSIENT_EXIT_CODES.includes(result.exitCode) &&
        (await darwinJobLoaded());
      if (!retry) throw commandFailure('launchctl bootstrap', result);
      await sleep(delay);
    }
  };
  /** Replace the loaded job with the plist on disk and start it. */
  const darwinReload = async (): Promise<void> => {
    await darwinBootout();
    await darwinBootstrapRequired();
    await requireCommand(['launchctl', 'kickstart', '-k', darwinTarget], 'launchctl kickstart');
  };
  /**
   * Kick the job, loading it into the domain first when it is not there (after
   * a `stop`, or a bootout whose bootstrap never landed). That load is the
   * required one: it used to be a single tolerated attempt, so a job that
   * failed to load reported a kickstart error for a job that never existed
   * instead of the refusal that explains it. A loaded job is not bootstrapped
   * again, which only fails. `force` bounces one that is running.
   */
  const darwinBounce = async (force: boolean): Promise<void> => {
    if (!(await darwinJobLoaded())) await darwinBootstrapRequired();
    await requireCommand(
      ['launchctl', 'kickstart', ...(force ? ['-k'] : []), darwinTarget],
      'launchctl kickstart'
    );
  };
  const darwin = {
    async install(definition: UserServiceDefinition) {
      await deps.mkdir(posix.join(deps.home, 'Library', 'LaunchAgents'));
      await deps.writeFile(
        unitPath as string,
        renderLaunchdPlistFile(identity.launchdLabel, definition)
      );
      await darwinReload();
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
    start: () => darwinBounce(false),
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
    // `restart` is `start` with `-k` to bounce a job that is already running.
    // `kickstart` alone would fail after a `stop`, which now leaves the job out
    // of the domain — and every other backend restarts a stopped unit into a
    // running one.
    restart: () => darwinBounce(true),
    async restartRetargeted(program: string) {
      const updated = await retargetPhase('rewrite', program, false, async () => {
        const body = await retargetedUnitBody(program);
        if (body !== null) await deps.writeFile(unitPath as string, body);
        return body !== null;
      });
      // launchd keeps the plist it loaded: only a bootout and a bootstrap make
      // the job read the rewritten file, so both belong to this one operation.
      await retargetPhase('restart', program, updated, () =>
        updated ? darwinReload() : darwinBounce(true)
      );
      return updated;
    },
  };

  /** Run a PowerShell script, naming the cmdlet it stands for in any refusal. */
  const runPowerShell = (script: string, label: string): Promise<void> =>
    requireCommand(powershellArgv(script), label);

  const win32 = {
    install: (definition: UserServiceDefinition) =>
      runPowerShell(
        renderScheduledTaskInstallScript(identity.taskName, definition),
        'Register-ScheduledTask'
      ),
    uninstall: () =>
      runPowerShell(
        renderScheduledTaskVerbScript('unregister', identity.taskName),
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
      runPowerShell(
        renderScheduledTaskVerbScript('start', identity.taskName),
        'Start-ScheduledTask'
      ),
    stop: () =>
      runPowerShell(renderScheduledTaskVerbScript('stop', identity.taskName), 'Stop-ScheduledTask'),
    restart: restartTask,
    async restartRetargeted(program: string) {
      const retargeted = await retargetPhase('rewrite', program, false, () =>
        retargetTask(program)
      );
      await retargetPhase('restart', program, retargeted, restartTask);
      return retargeted;
    },
  };

  /** Store the task's new action arguments; false when nothing was installed or it already runs `program`. */
  async function retargetTask(program: string): Promise<boolean> {
    const read = await run(powershellArgv(renderScheduledTaskStatusScript(identity.taskName)));
    if (read.exitCode !== 0) throw commandFailure('Get-ScheduledTask', read);
    const task = parseScheduledTaskJson(read.stdout);
    if (!task?.installed || !task.arguments) return false;
    const updated = retargetScheduledTaskArguments(identity.taskName, task.arguments, program);
    if (updated === null) return false;
    await runPowerShell(
      renderScheduledTaskSetArgumentsScript(identity.taskName, updated),
      'Set-ScheduledTask'
    );
    return true;
  }

  function restartTask(): Promise<void> {
    return runPowerShell(
      renderScheduledTaskRestartScript(identity.taskName),
      'Stop-ScheduledTask/Start-ScheduledTask'
    );
  }

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

  /** Runs one half of `restartRetargeted`, so a failure names the half it came from. */
  async function retargetPhase<T>(
    phase: RestartRetargetedPhase,
    program: string,
    unitMoved: boolean,
    work: () => Promise<T>
  ): Promise<T> {
    try {
      return await work();
    } catch (cause) {
      throw new RestartRetargetedError({ phase, program, unitMoved, cause });
    }
  }

  async function run(argv: readonly string[]): Promise<UserServiceExecResult> {
    const env = argv[0] === 'systemctl' ? ((await sessionBus()) ?? deps.env) : deps.env;
    return await deps.exec(argv, { env });
  }

  function commandFailure(label: string, result: UserServiceExecResult): Error {
    const detail = result.stderr.trim() || result.stdout.trim();
    return new RuntimeServiceManagementError(
      'runtime_service_unsupported',
      `${label} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`
    );
  }

  async function requireCommand(argv: readonly string[], label: string): Promise<void> {
    const result = await run(argv);
    if (result.exitCode !== 0) throw commandFailure(label, result);
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
    restartRetargeted: async (program) => await require().restartRetargeted(program),
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
  const encoded = args ? TASK_ENCODED_COMMAND.exec(args)?.[1] : undefined;
  if (!encoded) return execute;
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  const quoted = RUNNER_PROGRAM_LINE.exec(script)?.[0];
  // Drop the `& '` opener and the closing quote, then undo the doubling.
  return quoted ? quoted.slice(3, -1).replaceAll("''", "'") : execute;
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
      : // Task Scheduler may return arbitrary values; preserve their prior diagnostic rendering.
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        String(record.state ?? 'Unknown');
  return {
    installed: true,
    state,
    enabled: record.enabled !== false,
    execute: typeof record.execute === 'string' && record.execute ? record.execute : null,
    arguments: typeof record.arguments === 'string' && record.arguments ? record.arguments : null,
  };
}

async function attemptEnableLinger(
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
