import { describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import Value from 'typebox/value';

import {
  createUserServiceManager,
  currentUserName,
  decodePowerShellArgv,
  defaultUserServiceExecDeps,
  execPathFromUnitBody,
  parseScheduledTaskJson,
  programFromTaskAction,
  renderLaunchdPlistFile,
  renderScheduledTaskInstallScript,
  renderScheduledTaskRunnerScript,
  renderSystemdUnitFile,
  replaceUnitProgram,
  RestartRetargetedError,
  retargetScheduledTaskArguments,
  systemdUserUnitPath,
  type UserServiceDefinition,
  type UserServiceExecDeps,
  type UserServiceExecResult,
  type UserServiceIdentity,
  type UserServiceManager,
} from '../../../src/machine/user-service';
import { RuntimeServiceManagementError } from '../../../src/runtime-contract';
import { UserServiceStatusSchema } from '../../../src/runtime-home';
import { CAPTURED_PROGRESS_THEN_THROW } from './clixml-captures';

const IDENTITY: UserServiceIdentity = {
  unitName: 'example.service',
  launchdLabel: 'com.example.unit',
  taskName: 'Example Unit',
  cliName: 'example',
  docsUrl: 'https://example.test/docs',
};

const DEFINITION: UserServiceDefinition = {
  description: 'Example (serve)',
  argv: ['/opt/My Apps/example', 'serve'],
  workingDirectory: '/opt/My Apps',
  env: { EXAMPLE_LOG: "/home/test/logs/it's.log" },
  logFile: '/home/test/logs/example.log',
};

/** In-memory seam: records argv, keeps written files, answers from `onExec`. */
class FakeServiceHost {
  readonly argv: string[][] = [];
  readonly envs: NodeJS.ProcessEnv[] = [];
  readonly files = new Map<string, string>();
  readonly warnings: string[] = [];
  /** Everything the manager did, in order: commands and file removals. */
  readonly events: string[] = [];
  /** How often the manager went looking for systemctl. */
  hasSystemdCalls = 0;
  /** Mutable so a test can make the bus socket appear mid-life, as a login does. */
  busSocket: boolean;
  /** How often the manager looked for the bus socket. */
  busLookups = 0;
  /** Every backoff the manager asked for; none is actually waited. */
  readonly sleeps: number[] = [];

  constructor(
    private readonly options: {
      readonly platform?: NodeJS.Platform;
      readonly hasSystemd?: boolean;
      readonly env?: NodeJS.ProcessEnv;
      readonly busSocket?: boolean;
      readonly onExec?: (argv: readonly string[]) => UserServiceExecResult | undefined;
    } = {}
  ) {
    this.busSocket = options.busSocket ?? true;
  }

  deps(): UserServiceExecDeps {
    return {
      exec: (argv, options) => {
        this.argv.push([...argv]);
        this.envs.push(options?.env ?? {});
        this.events.push(argv.join(' '));
        return Promise.resolve(
          this.options.onExec?.(argv) ?? { exitCode: 0, stdout: '', stderr: '' }
        );
      },
      platform: this.options.platform ?? 'linux',
      env: {
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
        ...this.options.env,
      },
      home: '/home/test',
      uid: 1000,
      user: 'test',
      hasSystemd: () => {
        this.hasSystemdCalls += 1;
        return Promise.resolve(this.options.hasSystemd ?? true);
      },
      writeFile: (path, contents) => {
        this.files.set(path, contents);
        return Promise.resolve();
      },
      readFile: (path) => {
        const value = this.files.get(path);
        return value === undefined
          ? Promise.reject(new Error(`ENOENT ${path}`))
          : Promise.resolve(value);
      },
      unlink: (path) => {
        this.files.delete(path);
        this.events.push(`unlink ${path}`);
        return Promise.resolve();
      },
      mkdir: () => Promise.resolve(),
      pathExists: (path) => {
        if (!path.endsWith('/bus')) return Promise.resolve(true);
        this.busLookups += 1;
        return Promise.resolve(this.busSocket);
      },
      warn: (message) => {
        this.warnings.push(message);
      },
      sleep: (ms) => {
        this.sleeps.push(ms);
        return Promise.resolve();
      },
    };
  }
}

describe('renderSystemdUnitFile', () => {
  it('quotes argv, working directory and environment, and appends output to the log', () => {
    const unit = renderSystemdUnitFile(DEFINITION);
    expect(unit).toContain('ExecStart="/opt/My Apps/example" serve');
    expect(unit).toContain('WorkingDirectory="/opt/My Apps"');
    expect(unit).toContain('Environment="EXAMPLE_LOG=/home/test/logs/it\'s.log"');
    expect(unit).toContain('StandardOutput=append:/home/test/logs/example.log');
    expect(unit).toContain('StandardError=append:/home/test/logs/example.log');
    expect(unit).toContain('Restart=on-failure');
  });

  it('doubles specifiers and expansions, and refuses a value a unit line cannot hold', () => {
    const unit = renderSystemdUnitFile({
      description: 'x',
      argv: ['/opt/100%/app', '$HOME'],
      env: { RATE: '50%', LITERAL: '$notexpanded' },
    });
    expect(unit).toContain('ExecStart=/opt/100%%/app $$HOME');
    expect(unit).toContain('Environment="RATE=50%%"');
    expect(unit).toContain('Environment="LITERAL=$notexpanded"');
    expect(() =>
      renderSystemdUnitFile({ description: 'x', argv: ['/x'], env: { BAD: 'a\nb' } })
    ).toThrow(/BAD contains a line break/);
  });

  it('leaves a plain argv unquoted', () => {
    const unit = renderSystemdUnitFile({ description: 'x', argv: ['/usr/bin/example', 'serve'] });
    expect(unit).toContain('ExecStart=/usr/bin/example serve');
    expect(unit).not.toContain('WorkingDirectory');
    expect(unit).not.toContain('Environment=');
  });
});

describe('systemdUserUnitPath', () => {
  it('uses the Linux path layout independently of the process platform', () => {
    expect(systemdUserUnitPath('/home/test', IDENTITY.unitName)).toBe(
      '/home/test/.config/systemd/user/example.service'
    );
  });
});

describe('renderLaunchdPlistFile', () => {
  it('carries working directory, environment and log paths at the job top level', () => {
    const plist = renderLaunchdPlistFile('com.example.unit', DEFINITION);
    expect(plist).toContain('<string>com.example.unit</string>');
    expect(plist).toContain('<string>/opt/My Apps/example</string>');
    expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/opt/My Apps</string>');
    expect(plist).toContain('<key>EXAMPLE_LOG</key>');
    expect(plist).toContain(
      '<key>StandardOutPath</key>\n  <string>/home/test/logs/example.log</string>'
    );
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/
    );
  });

  // `ThrottleInterval` is a job key. Inside the `KeepAlive` dict launchd reads
  // it as a keep-alive condition instead, and the job respawns with no delay.
  it('places ThrottleInterval at job top level, not inside KeepAlive', () => {
    const plist = renderLaunchdPlistFile('com.example.unit', DEFINITION);
    const keepAlive = plist.match(/<key>KeepAlive<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1];
    expect(keepAlive).toContain('<key>SuccessfulExit</key>');
    expect(keepAlive).not.toContain('ThrottleInterval');

    const tail = plist.split(/<key>KeepAlive<\/key>\s*<dict>[\s\S]*?<\/dict>/)[1];
    expect(tail).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
  });
});

describe('Scheduled Task scripts', () => {
  it('disables the execution time limit and runs the program hidden with output appended', () => {
    const script = renderScheduledTaskInstallScript('Example Unit', {
      ...DEFINITION,
      argv: ['C:\\Users\\me\\bin\\example.cmd', 'serve'],
      workingDirectory: 'C:\\Users\\me',
      logFile: 'C:\\Users\\me\\logs\\example.log',
    });
    expect(script).toContain('-ExecutionTimeLimit (New-TimeSpan -Seconds 0)');
    expect(script).toContain('-MultipleInstances IgnoreNew');
    expect(script).toContain("Register-ScheduledTask -TaskName 'Example Unit'");
    expect(script).toContain('-Force');
    expect(script).toContain("Start-ScheduledTask -TaskName 'Example Unit'");

    const runner = renderScheduledTaskRunnerScript({
      ...DEFINITION,
      argv: ['C:\\Users\\me\\bin\\example.cmd', 'serve'],
      workingDirectory: 'C:\\Users\\me',
      logFile: 'C:\\Users\\me\\logs\\example.log',
    });
    expect(runner).toContain("$env:EXAMPLE_LOG = '/home/test/logs/it''s.log'");
    expect(runner).toContain("Set-Location 'C:\\Users\\me'");
    expect(runner).toContain(
      "& 'C:\\Users\\me\\bin\\example.cmd' 'serve' 2>&1 | Out-File -Append -Encoding utf8 -FilePath 'C:\\Users\\me\\logs\\example.log'"
    );
  });

  it('exits with the wrapped program status so a crash is not read as a clean run', () => {
    const runner = renderScheduledTaskRunnerScript(DEFINITION);

    // The pipeline's status is `Out-File`'s, and a PowerShell that ends
    // normally exits 0 — so without this Task Scheduler records every crash as
    // a success and never spends its RestartCount.
    expect(runner.endsWith('\nexit $LASTEXITCODE')).toBe(true);
  });

  // `$LASTEXITCODE` is unset when the program never ran — a missing executable
  // after an upgrade — and `exit $null` is `exit 0`, which is the same lie the
  // line above exists to stop.
  it('fails the run when the program never started, rather than exiting null', () => {
    const runner = renderScheduledTaskRunnerScript(DEFINITION);
    expect(runner).toContain('if ($null -eq $LASTEXITCODE) { exit 1 }');
    expect(runner.indexOf('$null -eq $LASTEXITCODE')).toBeLessThan(
      runner.lastIndexOf('exit $LASTEXITCODE')
    );
  });

  it('refuses a command Task Scheduler would silently cut', () => {
    // Everything the task runs is base64 in one argument, and an argument over
    // the limit comes back cut — which decodes to a truncated script, so the
    // task registers, reports installed, and runs a broken hub.
    const enormous = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`MANGO_KEY_${i}`, 'v'.repeat(200)])
    );

    expect(() =>
      renderScheduledTaskInstallScript('Example Unit', { ...DEFINITION, env: enormous })
    ).toThrow(/over the 8192 Task Scheduler accepts/);

    // The refusal has to be the shape every backend raises, or the CLI prints a
    // stack trace and the machine route answers 500 instead of 409.
    expect(() =>
      renderScheduledTaskInstallScript('Example Unit', { ...DEFINITION, env: enormous })
    ).toThrow(RuntimeServiceManagementError);
  });

  it('reads the state name from both PowerShell 5.1 and 7 JSON', () => {
    expect(parseScheduledTaskJson('{"installed":true,"state":4,"enabled":true}')?.state).toBe(
      'Running'
    );
    expect(parseScheduledTaskJson('{"installed":true,"state":"Ready","enabled":true}')?.state).toBe(
      'Ready'
    );
    expect(parseScheduledTaskJson('{"installed":true,"state":{"invalid":true}}')?.state).toBe(
      '[object Object]'
    );
    expect(parseScheduledTaskJson('\r\n{"installed":false}\r\n')).toEqual({
      installed: false,
      state: 'absent',
      enabled: false,
      execute: null,
      arguments: null,
    });
    expect(parseScheduledTaskJson('not json')).toBeNull();
  });
});

describe('programFromTaskAction', () => {
  it('reads the wrapped program back out of the encoded runner', () => {
    const script = renderScheduledTaskInstallScript('Example Unit', {
      description: 'x',
      argv: ["C:\\Program Files\\it's\\example.exe", 'serve'],
      logFile: 'C:\\logs\\x.log',
    });
    const args = script.match(/-Argument '([^']+)'/)?.[1] ?? '';
    expect(programFromTaskAction('powershell.exe', args)).toBe(
      "C:\\Program Files\\it's\\example.exe"
    );
    expect(programFromTaskAction('C:\\other.exe', null)).toBe('C:\\other.exe');
  });
});

describe('execPathFromUnitBody', () => {
  it('reads a quoted systemd ExecStart and a launchd program argument', () => {
    expect(execPathFromUnitBody(renderSystemdUnitFile(DEFINITION))).toBe('/opt/My Apps/example');
    expect(execPathFromUnitBody(renderLaunchdPlistFile('x', DEFINITION))).toBe(
      '/opt/My Apps/example'
    );
    expect(execPathFromUnitBody('nothing here')).toBeNull();
  });
});

describe('createUserServiceManager on linux', () => {
  it('writes the unit, reloads, enables and tries to enable linger', async () => {
    const host = new FakeServiceHost({
      onExec: (argv) =>
        argv[0] === 'loginctl'
          ? { exitCode: 1, stdout: '', stderr: 'Interactive authentication required' }
          : undefined,
    });
    await createUserServiceManager(IDENTITY, host.deps()).install(DEFINITION);
    expect(host.files.get('/home/test/.config/systemd/user/example.service')).toContain(
      'ExecStart="/opt/My Apps/example" serve'
    );
    expect(host.argv).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'example.service'],
      ['loginctl', 'enable-linger', 'test'],
    ]);
    expect(host.warnings.join('\n')).toContain('sudo loginctl enable-linger test');
  });

  it('reports status from the unit and the supervisor, matching the shared schema', async () => {
    const host = new FakeServiceHost({
      onExec: (argv) => {
        if (argv.includes('is-enabled')) return { exitCode: 0, stdout: 'enabled', stderr: '' };
        if (argv.includes('is-active')) return { exitCode: 0, stdout: 'active', stderr: '' };
        if (argv[0] === 'loginctl') return { exitCode: 0, stdout: 'Linger=no', stderr: '' };
        return undefined;
      },
    });
    host.files.set(
      '/home/test/.config/systemd/user/example.service',
      renderSystemdUnitFile(DEFINITION)
    );
    const status = await createUserServiceManager(IDENTITY, host.deps()).status();
    expect(Value.Check(UserServiceStatusSchema, status)).toBe(true);
    expect(status).toMatchObject({
      platform: 'linux',
      unitName: 'example.service',
      installed: true,
      enabled: true,
      running: true,
      linger: false,
      execPath: '/opt/My Apps/example',
    });
  });

  it('removes the unit before stopping it, so a self-uninstall leaves no file behind', async () => {
    const host = new FakeServiceHost();
    host.files.set('/home/test/.config/systemd/user/example.service', 'x');
    await createUserServiceManager(IDENTITY, host.deps()).uninstall();
    expect(host.events).toEqual([
      'systemctl --user disable example.service',
      'unlink /home/test/.config/systemd/user/example.service',
      'systemctl --user daemon-reload',
      'systemctl --user --no-block stop example.service',
    ]);
  });

  it('restarts without blocking, so a service can bounce itself', async () => {
    const host = new FakeServiceHost();
    await createUserServiceManager(IDENTITY, host.deps()).restart();
    expect(host.argv).toEqual([
      ['systemctl', '--user', '--no-block', 'restart', 'example.service'],
    ]);
  });

  it('derives the session bus from the uid when the shell did not pass it', async () => {
    const host = new FakeServiceHost({
      env: { XDG_RUNTIME_DIR: '', DBUS_SESSION_BUS_ADDRESS: '' },
    });
    await createUserServiceManager(IDENTITY, host.deps()).start();
    expect(host.argv).toEqual([['systemctl', '--user', 'start', 'example.service']]);
    expect(host.envs[0]).toMatchObject({
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    });
  });

  it('refuses without a session bus and names the workaround for this CLI', async () => {
    const host = new FakeServiceHost({
      env: { XDG_RUNTIME_DIR: '', DBUS_SESSION_BUS_ADDRESS: '' },
      busSocket: false,
    });
    await expect(createUserServiceManager(IDENTITY, host.deps()).start()).rejects.toMatchObject({
      kind: 'runtime_service_no_session_bus',
      message: expect.stringContaining('example service <command>'),
    });
  });

  // A machine with no systemd has no session bus either, and the bus refusal
  // hands out "export XDG_RUNTIME_DIR and try again" — advice that cannot work
  // there. `status()` already asked in this order; the actions did not.
  it('names the missing systemd before the missing bus', async () => {
    const host = new FakeServiceHost({
      hasSystemd: false,
      busSocket: false,
      env: { XDG_RUNTIME_DIR: '', DBUS_SESSION_BUS_ADDRESS: '' },
    });

    await expect(createUserServiceManager(IDENTITY, host.deps()).start()).rejects.toMatchObject({
      kind: 'runtime_service_unsupported',
      message: expect.stringContaining('systemd user services are not available'),
    });
  });

  // The machine page polls status every two seconds during an action window,
  // and whether this machine has systemctl cannot change while this process
  // runs — so it is asked once, like the session bus already was.
  it('looks for systemctl once per manager, however often it is asked', async () => {
    const host = new FakeServiceHost();
    const manager = createUserServiceManager(IDENTITY, host.deps());

    await manager.status();
    await manager.status();
    await manager.start();

    expect(host.hasSystemdCalls).toBe(1);
  });
});

describe('createUserServiceManager status errors', () => {
  it('codes the refusals this project raises, and only those', async () => {
    const noSystemd = new FakeServiceHost({ hasSystemd: false });
    const noBus = new FakeServiceHost({
      busSocket: false,
      env: { XDG_RUNTIME_DIR: '', DBUS_SESSION_BUS_ADDRESS: '' },
    });

    const first = await createUserServiceManager(IDENTITY, noSystemd.deps()).status();
    const second = await createUserServiceManager(IDENTITY, noBus.deps()).status();

    // The page words these; the message stays as the diagnostic line, and a
    // supervisor's own stderr gets no code because no dictionary can hold it.
    expect(first).toMatchObject({ errorCode: 'no-systemd', error: 'systemd is not available' });
    expect(second).toMatchObject({ errorCode: 'no-session-bus', error: 'no session bus' });
  });

  // The hub builds one manager for the life of the process. `hasSystemd` asks
  // about the machine and cannot change; the bus socket appears the moment
  // somebody logs in, so a `serve -d` started over SSH would otherwise report
  // `no-session-bus` and refuse `service install` forever after.
  it('looks for the session bus again after it was missing, unlike systemd', async () => {
    const host = new FakeServiceHost({
      busSocket: false,
      env: { XDG_RUNTIME_DIR: '', DBUS_SESSION_BUS_ADDRESS: '' },
    });
    const manager = createUserServiceManager(IDENTITY, host.deps());

    expect(await manager.status()).toMatchObject({ errorCode: 'no-session-bus' });
    host.busSocket = true;

    const recovered = await manager.status();
    expect(recovered.errorCode).toBeUndefined();
    expect(recovered.error).toBeUndefined();
    expect(host.busLookups).toBe(2);
    // The machine question stays answered once.
    expect(host.hasSystemdCalls).toBe(1);
  });
});

describe('createUserServiceManager on darwin', () => {
  it('bootstraps the agent and kickstarts it', async () => {
    const host = new FakeServiceHost({ platform: 'darwin' });
    await createUserServiceManager(IDENTITY, host.deps()).install(DEFINITION);
    const plistPath = '/home/test/Library/LaunchAgents/com.example.unit.plist';
    expect(host.files.get(plistPath)).toContain('<string>/opt/My Apps/example</string>');
    expect(host.argv).toEqual([
      ['launchctl', 'bootout', 'gui/1000/com.example.unit'],
      ['launchctl', 'bootstrap', 'gui/1000', plistPath],
      ['launchctl', 'kickstart', '-k', 'gui/1000/com.example.unit'],
    ]);
  });

  it('unlinks the plist before booting the agent out', async () => {
    const host = new FakeServiceHost({ platform: 'darwin' });
    host.files.set('/home/test/Library/LaunchAgents/com.example.unit.plist', 'x');
    await createUserServiceManager(IDENTITY, host.deps()).uninstall();
    expect(host.events).toEqual([
      'unlink /home/test/Library/LaunchAgents/com.example.unit.plist',
      'launchctl bootout gui/1000/com.example.unit',
    ]);
  });

  it('boots the agent out to stop it, since a signalled job is one KeepAlive revives', async () => {
    const host = new FakeServiceHost({ platform: 'darwin' });

    await createUserServiceManager(IDENTITY, host.deps()).stop();

    // The plist sets KeepAlive.SuccessfulExit false, so `launchctl kill TERM`
    // is an unsuccessful exit and launchd starts the job again after the
    // throttle interval — with the caller told it had stopped.
    expect(host.argv).toEqual([['launchctl', 'bootout', 'gui/1000/com.example.unit']]);
  });

  it('treats a job that was not loaded as already stopped', async () => {
    const host = new FakeServiceHost({
      platform: 'darwin',
      // `bootout` fails when there is nothing to boot out, and `print` fails
      // for the same reason — which is the state `stop` was asked to reach.
      onExec: () => ({ exitCode: 3, stdout: '', stderr: 'No such process' }),
    });

    await createUserServiceManager(IDENTITY, host.deps()).stop();

    expect(host.argv.map((argv) => argv[1])).toEqual(['bootout', 'print']);
  });

  it('reports a stop that left the job loaded', async () => {
    const host = new FakeServiceHost({
      platform: 'darwin',
      onExec: (argv) =>
        argv[1] === 'bootout'
          ? { exitCode: 1, stdout: '', stderr: 'Operation not permitted' }
          : undefined,
    });

    await expect(createUserServiceManager(IDENTITY, host.deps()).stop()).rejects.toMatchObject({
      message: expect.stringContaining(
        'launchctl bootout failed (exit 1): Operation not permitted'
      ),
    });
  });

  /** A darwin host whose job has left the domain: `print` and `kickstart` find nothing until a bootstrap loads it. */
  function stoppedJobHost(bootstrap: UserServiceExecResult | null = null): FakeServiceHost {
    let loaded = false;
    return new FakeServiceHost({
      platform: 'darwin',
      onExec: (argv) => {
        if (argv[1] === 'bootstrap') {
          if (bootstrap) return bootstrap;
          loaded = true;
        }
        if ((argv[1] === 'print' || argv[1] === 'kickstart') && !loaded) {
          return { exitCode: 113, stdout: '', stderr: 'Could not find service' };
        }
        return undefined;
      },
    });
  }

  it('bootstraps before kickstarting on restart, so a stopped job comes back', async () => {
    const host = stoppedJobHost();

    await createUserServiceManager(IDENTITY, host.deps()).restart();

    // `stop` boots the job out of the domain, so `kickstart` alone would fail
    // with "Could not find service" while the CLI reported a restart. systemd
    // and Task Scheduler both start a stopped unit on restart.
    expect(host.argv).toEqual([
      ['launchctl', 'print', 'gui/1000/com.example.unit'],
      [
        'launchctl',
        'bootstrap',
        'gui/1000',
        '/home/test/Library/LaunchAgents/com.example.unit.plist',
      ],
      ['launchctl', 'kickstart', '-k', 'gui/1000/com.example.unit'],
    ]);
  });

  it('bootstraps before kickstarting, since a stopped job has left the domain', async () => {
    const host = stoppedJobHost();

    await createUserServiceManager(IDENTITY, host.deps()).start();

    expect(host.argv).toEqual([
      ['launchctl', 'print', 'gui/1000/com.example.unit'],
      [
        'launchctl',
        'bootstrap',
        'gui/1000',
        '/home/test/Library/LaunchAgents/com.example.unit.plist',
      ],
      ['launchctl', 'kickstart', 'gui/1000/com.example.unit'],
    ]);
  });

  it('kickstarts a job that is already loaded without bootstrapping it again', async () => {
    const host = new FakeServiceHost({ platform: 'darwin' });

    await createUserServiceManager(IDENTITY, host.deps()).restart();

    // A bootstrap of a loaded job only fails, so it is not attempted.
    expect(host.argv).toEqual([
      ['launchctl', 'print', 'gui/1000/com.example.unit'],
      ['launchctl', 'kickstart', '-k', 'gui/1000/com.example.unit'],
    ]);
  });

  // A restart that lost the race against a bootout left the job out of the
  // domain. The single tolerated bootstrap failed too, the kickstart found
  // nothing, and what surfaced was a kickstart error for a job that was never
  // loaded — not the bootstrap refusal that explains it.
  it('reports the failed bootstrap of an unloaded job instead of kickstarting nothing', async () => {
    const host = stoppedJobHost({
      exitCode: 5,
      stdout: '',
      stderr: 'Bootstrap failed: 5: Input/output error',
    });

    await expect(createUserServiceManager(IDENTITY, host.deps()).restart()).rejects.toMatchObject({
      message: 'launchctl bootstrap failed (exit 5): Bootstrap failed: 5: Input/output error',
    });

    expect(host.argv.some((argv) => argv[1] === 'kickstart')).toBe(false);
  });
});

describe('createUserServiceManager on win32', () => {
  it('reports a registered running task', async () => {
    const host = new FakeServiceHost({
      platform: 'win32',
      onExec: () => ({
        exitCode: 0,
        stdout:
          '{"installed":true,"state":4,"enabled":true,"execute":"powershell.exe","arguments":"-NoProfile","lastResult":0}\r\n',
        stderr: '',
      }),
    });
    const status = await createUserServiceManager(IDENTITY, host.deps()).status();
    expect(Value.Check(UserServiceStatusSchema, status)).toBe(true);
    expect(status).toMatchObject({
      platform: 'win32',
      unitName: 'Example Unit',
      installed: true,
      enabled: true,
      running: true,
    });
    expect(decodePowerShellArgv(host.argv[0] ?? [])).toContain(
      "Get-ScheduledTask -TaskName 'Example Unit'"
    );
  });

  it('silences PowerShell progress records on the first line of every script it runs', async () => {
    const host = new FakeServiceHost({ platform: 'win32' });
    await createUserServiceManager(IDENTITY, host.deps()).start();
    const script = decodePowerShellArgv(host.argv[0] ?? []) ?? '';
    expect(script.split('\n')[0]).toStartWith("$ProgressPreference = 'SilentlyContinue'; ");
  });

  it('quotes the script own error text, not a CLIXML envelope, when a task command fails', async () => {
    const host = new FakeServiceHost({
      platform: 'win32',
      onExec: () => ({
        exitCode: 1,
        stdout: '',
        stderr: CAPTURED_PROGRESS_THEN_THROW,
      }),
    });
    const failure = await createUserServiceManager(IDENTITY, host.deps())
      .stop()
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(failure, 'expected stop to reject when PowerShell exits 1').toBeInstanceOf(
      RuntimeServiceManagementError
    );
    const message = (failure as Error).message;
    expect(message).toContain('Stop-ScheduledTask failed (exit 1): boom-after-progress');
    expect(
      message,
      `expected no envelope text in the operator message | received: ${message}`
    ).not.toMatch(/CLIXML|<Objs|_x000D_/);
  });

  it('reports a status failure as the script own error text, not a CLIXML envelope', async () => {
    const host = new FakeServiceHost({
      platform: 'win32',
      onExec: () => ({
        exitCode: 1,
        stdout: '',
        stderr: CAPTURED_PROGRESS_THEN_THROW,
      }),
    });
    const status = await createUserServiceManager(IDENTITY, host.deps()).status();
    expect(status.error).toStartWith('boom-after-progress');
    expect(status.error).not.toMatch(/CLIXML|<Objs|_x000D_/);
  });

  it('leaves the stderr of every other supervisor command as the program wrote it', async () => {
    const host = new FakeServiceHost({
      platform: 'linux',
      onExec: (argv) =>
        argv[1] === '--user' && argv[2] === 'start'
          ? { exitCode: 1, stdout: '', stderr: CAPTURED_PROGRESS_THEN_THROW }
          : undefined,
    });
    const failure = await createUserServiceManager(IDENTITY, host.deps())
      .start()
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect((failure as Error | undefined)?.message).toContain('#< CLIXML');
  });

  it('stops the task before unregistering it, since unregistering leaves it running', async () => {
    const host = new FakeServiceHost({ platform: 'win32' });
    await createUserServiceManager(IDENTITY, host.deps()).uninstall();
    const script = decodePowerShellArgv(host.argv[0] ?? []) ?? '';
    expect(script).toContain("Unregister-ScheduledTask -TaskName 'Example Unit' -Confirm:$false");
    expect(script.indexOf('Stop-ScheduledTask')).toBeLessThan(
      script.indexOf('Unregister-ScheduledTask')
    );
  });

  it('waits for the old instance to end before starting the task again', async () => {
    const host = new FakeServiceHost({ platform: 'win32' });
    await createUserServiceManager(IDENTITY, host.deps()).restart();
    const script = decodePowerShellArgv(host.argv[0] ?? []) ?? '';
    expect(script.indexOf('Stop-ScheduledTask')).toBeLessThan(script.indexOf('Start-Sleep'));
    expect(script.indexOf('Start-Sleep')).toBeLessThan(script.indexOf('Start-ScheduledTask'));
    expect(script).toContain("-eq 'Running'");
  });
});

describe('replaceUnitProgram', () => {
  const STABLE = '/opt/homebrew/bin/mangostudio';

  it('replaces the systemd program and keeps arguments, environment and log lines', () => {
    const body = renderSystemdUnitFile(DEFINITION);
    const updated = replaceUnitProgram(body, STABLE) ?? '';
    expect(updated).toBe(
      body.replace('ExecStart="/opt/My Apps/example" serve', `ExecStart=${STABLE} serve`)
    );
    expect(execPathFromUnitBody(updated)).toBe(STABLE);
  });

  it('quotes a replacement program the way renderSystemdUnitFile would', () => {
    const body = renderSystemdUnitFile({ ...DEFINITION, argv: ['/plain/example', 'serve'] });
    const updated = replaceUnitProgram(body, '/opt/My Apps/new') ?? '';
    expect(updated).toContain('ExecStart="/opt/My Apps/new" serve');
  });

  // systemd reads `-`, `@`, `:`, `+` and `!` before the path as execution
  // modifiers (ignore failure, argv[0] override, ...). They are the operator's
  // and are not part of the program, so a retarget must neither drop them nor
  // report them as part of the path.
  for (const prefix of ['-', '@', ':', '+', '!', '!!', '-+']) {
    it(`keeps the "${prefix}" ExecStart prefix while replacing the program`, () => {
      const body = renderSystemdUnitFile(DEFINITION).replace(
        'ExecStart="/opt/My Apps/example" serve',
        `ExecStart=${prefix}/old/example serve`
      );
      expect(execPathFromUnitBody(body)).toBe('/old/example');

      const updated = replaceUnitProgram(body, STABLE) ?? '';

      expect(updated).toContain(`ExecStart=${prefix}${STABLE} serve`);
      expect(execPathFromUnitBody(updated)).toBe(STABLE);
    });
  }

  it('keeps a prefix in front of a quoted program', () => {
    const body = renderSystemdUnitFile(DEFINITION).replace(
      'ExecStart="/opt/My Apps/example"',
      'ExecStart=-"/opt/My Apps/example"'
    );
    expect(execPathFromUnitBody(body)).toBe('/opt/My Apps/example');
    expect(replaceUnitProgram(body, '/opt/My Apps/new')).toContain(
      'ExecStart=-"/opt/My Apps/new" serve'
    );
  });

  it('replaces the launchd program and keeps the rest of the plist', () => {
    const body = renderLaunchdPlistFile('com.example.unit', DEFINITION);
    const updated = replaceUnitProgram(body, STABLE) ?? '';
    expect(updated).toBe(
      body.replace('<string>/opt/My Apps/example</string>', `<string>${STABLE}</string>`)
    );
    expect(execPathFromUnitBody(updated)).toBe(STABLE);
  });

  it('returns null for a body that names no program', () => {
    expect(replaceUnitProgram('nothing here', STABLE)).toBeNull();
  });
});

describe('createUserServiceManager restartRetargeted', () => {
  const STABLE = '/home/linuxbrew/.linuxbrew/bin/mangostudio';
  const VERSIONED: UserServiceDefinition = {
    ...DEFINITION,
    argv: ['/home/linuxbrew/.linuxbrew/Cellar/mangostudio/0.1.1/libexec/mangostudio', 'serve'],
  };
  const PLIST_PATH = '/home/test/Library/LaunchAgents/com.example.unit.plist';
  const LAUNCHD_TARGET = 'gui/1000/com.example.unit';
  const BOOTSTRAP = ['launchctl', 'bootstrap', 'gui/1000', PLIST_PATH];
  const EIO_STDERR = 'Bootstrap failed: 5: Input/output error';

  /**
   * A darwin host whose `launchctl bootstrap`, `bootout` and `print` answer from
   * the queued results, then succeed. A `print` that succeeds is a job launchd
   * still has in its domain.
   */
  function darwinHost(
    bootstrapResults: readonly UserServiceExecResult[] = [],
    others: {
      readonly bootout?: readonly UserServiceExecResult[];
      readonly print?: readonly UserServiceExecResult[];
    } = {}
  ): FakeServiceHost {
    const queues: Record<string, UserServiceExecResult[]> = {
      bootstrap: [...bootstrapResults],
      bootout: [...(others.bootout ?? [])],
      print: [...(others.print ?? [])],
    };
    const host = new FakeServiceHost({
      platform: 'darwin',
      onExec: (argv) => queues[argv[1] ?? '']?.shift(),
    });
    host.files.set(PLIST_PATH, renderLaunchdPlistFile('com.example.unit', VERSIONED));
    return host;
  }

  const eio = (): UserServiceExecResult => ({ exitCode: 5, stdout: '', stderr: EIO_STDERR });
  const inProgress = (): UserServiceExecResult => ({
    exitCode: 37,
    stdout: '',
    stderr: 'Boot-out failed: 37: Operation already in progress',
  });
  /** What `launchctl print` answers for a job that is not in the domain. */
  const notLoaded = (): UserServiceExecResult => ({
    exitCode: 113,
    stdout: '',
    stderr: 'Could not find service "com.example.unit" in domain for user gui: 1000',
  });

  it('on linux rewrites only the program and reloads systemd before the restart', async () => {
    const host = new FakeServiceHost();
    const unitPath = '/home/test/.config/systemd/user/example.service';
    host.files.set(unitPath, renderSystemdUnitFile(VERSIONED));
    const manager = createUserServiceManager(IDENTITY, host.deps());

    expect(await manager.restartRetargeted(STABLE)).toBe(true);

    const written = host.files.get(unitPath) ?? '';
    expect(execPathFromUnitBody(written)).toBe(STABLE);
    expect(written).toContain(`ExecStart=${STABLE} serve`);
    expect(written).toContain('WorkingDirectory="/opt/My Apps"');
    expect(written).toContain('StandardOutput=append:/home/test/logs/example.log');
    expect(host.argv).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', '--no-block', 'restart', 'example.service'],
    ]);
  });

  it('on linux only restarts a unit that already runs the program', async () => {
    const host = new FakeServiceHost();
    const unitPath = '/home/test/.config/systemd/user/example.service';
    const body = renderSystemdUnitFile({ ...VERSIONED, argv: [STABLE, 'serve'] });
    host.files.set(unitPath, body);

    expect(await createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(STABLE)).toBe(
      false
    );
    expect(host.files.get(unitPath)).toBe(body);
    expect(host.argv).toEqual([
      ['systemctl', '--user', '--no-block', 'restart', 'example.service'],
    ]);
  });

  it('on linux writes nothing when no unit is installed', async () => {
    const host = new FakeServiceHost();
    expect(await createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(STABLE)).toBe(
      false
    );
    expect(host.files.size).toBe(0);
  });

  it('on darwin rewrites the plist, boots the job out, bootstraps it again and kicks it', async () => {
    const host = darwinHost();

    expect(await createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(STABLE)).toBe(
      true
    );

    expect(execPathFromUnitBody(host.files.get(PLIST_PATH) ?? '')).toBe(STABLE);
    expect(host.argv).toEqual([
      ['launchctl', 'bootout', LAUNCHD_TARGET],
      BOOTSTRAP,
      ['launchctl', 'kickstart', '-k', LAUNCHD_TARGET],
    ]);
  });

  // A bootstrap right after a bootout often answers error 5 while the old job
  // is still exiting. Tolerating it left the job out of the domain with the
  // restart reported as done.
  it('on darwin retries a bootstrap that answers error 5 and then kicks the job', async () => {
    const host = darwinHost([eio(), eio()]);

    expect(await createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(STABLE)).toBe(
      true
    );

    expect(host.argv.filter((argv) => argv[1] === 'bootstrap')).toHaveLength(3);
    expect(host.argv.at(-1)).toEqual(['launchctl', 'kickstart', '-k', LAUNCHD_TARGET]);
    // Each retry waits, and the waits grow.
    expect(host.sleeps).toHaveLength(2);
    expect(host.sleeps[1]).toBeGreaterThan(host.sleeps[0] ?? 0);
  });

  it('on darwin gives up on a bootstrap that keeps answering error 5, without a kickstart', async () => {
    const host = darwinHost(Array.from({ length: 20 }, eio));

    await expect(
      createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(STABLE)
    ).rejects.toMatchObject({
      phase: 'restart',
      reason: `launchctl bootstrap failed (exit 5): ${EIO_STDERR}`,
    });

    // Bounded: a handful of attempts, not the twenty the host would answer.
    const attempts = host.argv.filter((argv) => argv[1] === 'bootstrap').length;
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(6);
    expect(host.argv.some((argv) => argv[1] === 'kickstart')).toBe(false);
  });

  it('on darwin does not retry a bootstrap refusal that is not error 5', async () => {
    const host = darwinHost([{ exitCode: 1, stdout: '', stderr: 'Load failed: 1: bad plist' }]);

    await expect(
      createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(STABLE)
    ).rejects.toMatchObject({
      reason: 'launchctl bootstrap failed (exit 1): Load failed: 1: bad plist',
    });

    expect(host.argv.filter((argv) => argv[1] === 'bootstrap')).toHaveLength(1);
    expect(host.sleeps).toEqual([]);
  });

  // Error 5 also answers a bootstrap that failed for any other reason. Only a
  // job launchd still lists is one that is exiting, which is the wait's reason.
  it('on darwin gives up at once on error 5 when the job is no longer in the domain', async () => {
    const host = darwinHost([eio()], { print: [notLoaded()] });

    await expect(
      createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(STABLE)
    ).rejects.toMatchObject({ reason: `launchctl bootstrap failed (exit 5): ${EIO_STDERR}` });

    expect(host.argv.filter((argv) => argv[1] === 'bootstrap')).toHaveLength(1);
    expect(host.sleeps).toEqual([]);
  });

  it('on darwin retries error 37 (operation in progress) while the job is still loaded', async () => {
    const host = darwinHost([
      { exitCode: 37, stdout: '', stderr: 'Bootstrap failed: 37: Operation already in progress' },
    ]);

    await createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(STABLE);

    expect(host.argv.filter((argv) => argv[1] === 'bootstrap')).toHaveLength(2);
    expect(host.argv.at(-1)).toEqual(['launchctl', 'kickstart', '-k', LAUNCHD_TARGET]);
  });

  it('on darwin retries on the exit code alone, not on an error text under another code', async () => {
    const host = darwinHost([{ exitCode: 1, stdout: '', stderr: EIO_STDERR }]);

    await expect(
      createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(STABLE)
    ).rejects.toMatchObject({ reason: `launchctl bootstrap failed (exit 1): ${EIO_STDERR}` });

    expect(host.argv.filter((argv) => argv[1] === 'bootstrap')).toHaveLength(1);
  });

  it('on darwin waits for a job that is still exiting when the bootout says it is in progress', async () => {
    const stillLoaded = (): UserServiceExecResult => ({ exitCode: 0, stdout: '', stderr: '' });
    const host = darwinHost([], {
      bootout: [inProgress()],
      print: [stillLoaded(), stillLoaded(), notLoaded()],
    });

    await createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(STABLE);

    expect(host.argv.map((argv) => argv[1])).toEqual([
      'bootout',
      'print',
      'print',
      'print',
      'bootstrap',
      'kickstart',
    ]);
    expect(host.sleeps).toHaveLength(2);
  });

  it('on darwin names a bootout that failed with the job still loaded, without a bootstrap', async () => {
    const host = darwinHost([], {
      bootout: [{ exitCode: 1, stdout: '', stderr: 'Operation not permitted' }],
    });

    await expect(
      createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(STABLE)
    ).rejects.toMatchObject({
      reason: 'launchctl bootout failed (exit 1): Operation not permitted',
    });

    expect(host.argv.some((argv) => argv[1] === 'bootstrap')).toBe(false);
  });

  it('on darwin carries on past a bootout that failed because nothing was loaded', async () => {
    const host = darwinHost([], {
      bootout: [{ exitCode: 3, stdout: '', stderr: 'No such process' }],
      print: [notLoaded()],
    });

    await createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(STABLE);

    expect(host.argv.at(-1)).toEqual(['launchctl', 'kickstart', '-k', LAUNCHD_TARGET]);
  });

  it('on darwin only restarts a plist that already runs the program', async () => {
    const host = darwinHost();
    host.files.set(
      PLIST_PATH,
      renderLaunchdPlistFile('com.example.unit', { ...VERSIONED, argv: [STABLE, 'serve'] })
    );

    expect(await createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(STABLE)).toBe(
      false
    );
    expect(host.argv.some((argv) => argv[1] === 'bootout')).toBe(false);
    expect(host.argv.at(-1)).toEqual(['launchctl', 'kickstart', '-k', LAUNCHD_TARGET]);
  });

  it('on darwin install retries a bootstrap that answers error 5 too', async () => {
    const host = darwinHost([eio()]);

    await createUserServiceManager(IDENTITY, host.deps()).install(DEFINITION);

    expect(host.argv.filter((argv) => argv[1] === 'bootstrap')).toHaveLength(2);
    expect(host.argv.at(-1)).toEqual(['launchctl', 'kickstart', '-k', LAUNCHD_TARGET]);
  });

  describe('failure phases', () => {
    const LINUX_UNIT_PATH = '/home/test/.config/systemd/user/example.service';

    function linuxHost(failing?: string): FakeServiceHost {
      const host = new FakeServiceHost({
        onExec: (argv) =>
          failing !== undefined && argv.includes(failing)
            ? { exitCode: 1, stdout: '', stderr: `${failing} refused` }
            : undefined,
      });
      host.files.set(LINUX_UNIT_PATH, renderSystemdUnitFile(VERSIONED));
      return host;
    }

    async function failureOf(manager: UserServiceManager): Promise<unknown> {
      return await manager.restartRetargeted(STABLE).catch((error: unknown) => error);
    }

    it('on linux names the rewrite phase when systemd cannot reread the unit, without restarting', async () => {
      const host = linuxHost('daemon-reload');

      const failure = await failureOf(createUserServiceManager(IDENTITY, host.deps()));

      expect(failure).toBeInstanceOf(RestartRetargetedError);
      expect(failure).toMatchObject({ phase: 'rewrite', unitMoved: false });
      expect(host.argv.some((argv) => argv.includes('restart'))).toBe(false);
    });

    it('on linux names the rewrite phase for a unit that names no program', async () => {
      const host = new FakeServiceHost();
      host.files.set(LINUX_UNIT_PATH, '[Service]\nType=simple\n');

      const failure = await failureOf(createUserServiceManager(IDENTITY, host.deps()));

      expect(failure).toMatchObject({ phase: 'rewrite', unitMoved: false });
      expect((failure as Error).message).toContain('names no program to retarget');
    });

    it('on linux names the restart phase, with the unit already moved, when the restart fails', async () => {
      const host = linuxHost('restart');

      const failure = await failureOf(createUserServiceManager(IDENTITY, host.deps()));

      expect(failure).toBeInstanceOf(RestartRetargetedError);
      expect(failure).toMatchObject({ phase: 'restart', unitMoved: true });
      expect((failure as Error).message).toContain(`updated to run ${STABLE}`);
      expect((failure as Error).message).toContain('restart refused');
      // The file stays moved, so a later start or restart runs the new program.
      expect(execPathFromUnitBody(host.files.get(LINUX_UNIT_PATH) ?? '')).toBe(STABLE);
    });

    it('on linux names the restart phase without a move when the unit already ran the program', async () => {
      const host = linuxHost('restart');
      host.files.set(
        LINUX_UNIT_PATH,
        renderSystemdUnitFile({ ...VERSIONED, argv: [STABLE, 'serve'] })
      );

      await expect(
        failureOf(createUserServiceManager(IDENTITY, host.deps()))
      ).resolves.toMatchObject({ phase: 'restart', unitMoved: false });
    });

    it('on darwin names the rewrite phase for a plist that names no program, leaving the job loaded', async () => {
      const host = darwinHost();
      host.files.set(PLIST_PATH, '<plist><dict></dict></plist>');

      const failure = await failureOf(createUserServiceManager(IDENTITY, host.deps()));

      expect(failure).toMatchObject({ phase: 'rewrite', unitMoved: false });
      // Nothing was rewritten, so nothing was booted out either.
      expect(host.argv).toEqual([]);
    });

    it('on darwin names the restart phase, with the plist already moved, when the bootstrap gives up', async () => {
      const host = darwinHost(Array.from({ length: 20 }, eio));

      const failure = await failureOf(createUserServiceManager(IDENTITY, host.deps()));

      expect(failure).toBeInstanceOf(RestartRetargetedError);
      expect(failure).toMatchObject({ phase: 'restart', unitMoved: true });
      expect((failure as Error).message).toContain('launchctl bootstrap failed (exit 5)');
      expect(execPathFromUnitBody(host.files.get(PLIST_PATH) ?? '')).toBe(STABLE);
    });

    it('on darwin names the restart phase without a move when the kickstart of an unchanged plist fails', async () => {
      const host = new FakeServiceHost({
        platform: 'darwin',
        onExec: (argv) =>
          argv[1] === 'kickstart' ? { exitCode: 113, stdout: '', stderr: 'no service' } : undefined,
      });
      host.files.set(
        PLIST_PATH,
        renderLaunchdPlistFile('com.example.unit', { ...VERSIONED, argv: [STABLE, 'serve'] })
      );

      await expect(
        failureOf(createUserServiceManager(IDENTITY, host.deps()))
      ).resolves.toMatchObject({ phase: 'restart', unitMoved: false });
    });
  });

  describe('on win32', () => {
    const OLD_PROGRAM = 'C:\\Users\\me\\scoop\\apps\\mangostudio\\0.1.1\\mangostudio.exe';
    const NEW_PROGRAM = "C:\\Users\\it's me\\scoop\\apps\\mangostudio\\current\\mangostudio.exe";
    const WINDOWS_DEFINITION: UserServiceDefinition = {
      description: 'Example (serve)',
      argv: [OLD_PROGRAM, 'serve', '--port', '4100'],
      workingDirectory: 'C:\\Users\\me',
      env: { EXAMPLE_LOG: 'C:\\logs\\it.log' },
      logFile: 'C:\\logs\\example.log',
    };

    /** The `-Argument` Register-ScheduledTask records for `definition`. */
    function taskArgumentsFor(definition: UserServiceDefinition): string {
      const encoded = Buffer.from(renderScheduledTaskRunnerScript(definition), 'utf16le').toString(
        'base64'
      );
      return `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
    }

    function runnerOf(taskArguments: string): string {
      return (
        decodePowerShellArgv(['-EncodedCommand', taskArguments.split(/\s+/).at(-1) ?? '']) ?? ''
      );
    }

    /** A host that answers the status script with `taskArguments` and records every script. */
    function hostWithTask(
      taskArguments: string | null,
      setExit = 0,
      startExit = 0
    ): FakeServiceHost {
      return new FakeServiceHost({
        platform: 'win32',
        onExec: (argv) => {
          const script = decodePowerShellArgv(argv) ?? '';
          if (script.includes('ConvertTo-Json')) {
            return {
              exitCode: 0,
              stdout: `${JSON.stringify(
                taskArguments === null
                  ? { installed: false }
                  : {
                      installed: true,
                      state: 3,
                      enabled: true,
                      execute: 'powershell.exe',
                      arguments: taskArguments,
                    }
              )}\r\n`,
              stderr: '',
            };
          }
          if (script.includes('Set-ScheduledTask') && setExit !== 0) {
            return { exitCode: setExit, stdout: '', stderr: 'Access is denied' };
          }
          if (script.includes('Start-ScheduledTask') && startExit !== 0) {
            return { exitCode: startExit, stdout: '', stderr: 'The task is disabled' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      });
    }

    function scriptsRun(host: FakeServiceHost): string[] {
      return host.argv.map((argv) => decodePowerShellArgv(argv) ?? '');
    }

    it('swaps the program in the runner script and keeps everything else in it', async () => {
      const host = hostWithTask(taskArgumentsFor(WINDOWS_DEFINITION));

      expect(
        await createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(NEW_PROGRAM)
      ).toBe(true);

      const scripts = scriptsRun(host);
      // Retarget first, then the restart that starts what was written.
      expect(scripts.findIndex((script) => script.includes('Set-ScheduledTask'))).toBeLessThan(
        scripts.findIndex((script) => script.includes('Start-ScheduledTask'))
      );
      const setScript = scripts.find((script) => script.includes('Set-ScheduledTask'));
      expect(setScript).toContain("Set-ScheduledTask -TaskName 'Example Unit' -Action $action");
      expect(setScript).not.toContain('Register-ScheduledTask');
      // The new argument is computed here and handed over whole; the script
      // does not decode, rewrite or re-encode anything.
      expect(setScript).not.toContain('FromBase64String');
      const newArgument = /\$action\.Arguments = '((?:[^']|'')*)'/
        .exec(setScript ?? '')?.[1]
        ?.replaceAll("''", "'");
      expect(newArgument).toBe(
        taskArgumentsFor({ ...WINDOWS_DEFINITION, argv: [NEW_PROGRAM, 'serve', '--port', '4100'] })
      );
      expect(programFromTaskAction('powershell.exe', newArgument ?? null)).toBe(NEW_PROGRAM);
    });

    it('only restarts when the task is absent or already runs the program', async () => {
      const absent = hostWithTask(null);
      expect(
        await createUserServiceManager(IDENTITY, absent.deps()).restartRetargeted('C:\\x.exe')
      ).toBe(false);
      const current = hostWithTask(taskArgumentsFor(WINDOWS_DEFINITION));
      expect(
        await createUserServiceManager(IDENTITY, current.deps()).restartRetargeted(OLD_PROGRAM)
      ).toBe(false);
      for (const host of [absent, current]) {
        const scripts = scriptsRun(host);
        expect(scripts.filter((script) => script.includes('Set-ScheduledTask'))).toEqual([]);
        expect(scripts.some((script) => script.includes('Start-ScheduledTask'))).toBe(true);
      }
    });

    it('refuses a task that does not run an encoded runner script, without restarting', async () => {
      const host = hostWithTask('-NoProfile -File C:\\other.ps1');
      await expect(
        createUserServiceManager(IDENTITY, host.deps()).restartRetargeted('C:\\x.exe')
      ).rejects.toMatchObject({
        message: expect.stringContaining('does not run an encoded runner script'),
      });
      expect(scriptsRun(host).some((script) => script.includes('Start-ScheduledTask'))).toBe(false);
    });

    it('refuses a program that pushes the argument over what Task Scheduler accepts, before writing', async () => {
      const host = hostWithTask(taskArgumentsFor(WINDOWS_DEFINITION));
      const tooLong = `C:\\${'long\\'.repeat(1_200)}mangostudio.exe`;

      const failure = await createUserServiceManager(IDENTITY, host.deps())
        .restartRetargeted(tooLong)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(RuntimeServiceManagementError);
      expect((failure as Error).message).toMatch(/is \d+ characters, over the 8192 Task Scheduler/);
      const scripts = scriptsRun(host);
      expect(scripts.filter((script) => script.includes('Set-ScheduledTask'))).toEqual([]);
      expect(scripts.some((script) => script.includes('Start-ScheduledTask'))).toBe(false);
    });

    it('names the cmdlet and exit code when Task Scheduler refuses the write', async () => {
      const host = hostWithTask(taskArgumentsFor(WINDOWS_DEFINITION), 1);
      await expect(
        createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(NEW_PROGRAM)
      ).rejects.toMatchObject({
        phase: 'rewrite',
        reason: 'Set-ScheduledTask failed (exit 1): Access is denied',
      });
      // A task left as it was is not started as if it had been moved.
      expect(scriptsRun(host).some((script) => script.includes('Start-ScheduledTask'))).toBe(false);
    });

    it('names the restart phase, with the task already moved, when Start-ScheduledTask fails', async () => {
      const host = hostWithTask(taskArgumentsFor(WINDOWS_DEFINITION), 0, 1);

      const failure = await createUserServiceManager(IDENTITY, host.deps())
        .restartRetargeted(NEW_PROGRAM)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(RestartRetargetedError);
      expect(failure).toMatchObject({ phase: 'restart', unitMoved: true });
      expect((failure as Error).message).toContain('The service unit was updated to run');
      expect((failure as Error).message).toContain('The task is disabled');
    });

    it('names the rewrite phase, with the task untouched, when Set-ScheduledTask fails', async () => {
      const host = hostWithTask(taskArgumentsFor(WINDOWS_DEFINITION), 1);

      const failure = await createUserServiceManager(IDENTITY, host.deps())
        .restartRetargeted(NEW_PROGRAM)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(RestartRetargetedError);
      expect(failure).toMatchObject({ phase: 'rewrite', unitMoved: false });
    });

    it('names the restart phase without a move when the task already ran the program', async () => {
      const host = hostWithTask(taskArgumentsFor(WINDOWS_DEFINITION), 0, 1);

      await expect(
        createUserServiceManager(IDENTITY, host.deps()).restartRetargeted(OLD_PROGRAM)
      ).rejects.toMatchObject({ phase: 'restart', unitMoved: false });
    });

    it('replaces only the first program line of the runner script', () => {
      const runner = `& 'C:\\old.exe' serve\n& 'C:\\decoy.exe' tail\nexit 0`;
      const updated = retargetScheduledTaskArguments(
        'Example Unit',
        `-NoProfile -EncodedCommand ${Buffer.from(runner, 'utf16le').toString('base64')}`,
        'C:\\new.exe'
      );
      expect(runnerOf(updated ?? '')).toBe(`& 'C:\\new.exe' serve\n& 'C:\\decoy.exe' tail\nexit 0`);
    });

    it('does not read a `$` in the program as a replacement pattern', () => {
      const updated = retargetScheduledTaskArguments(
        'Example Unit',
        taskArgumentsFor(WINDOWS_DEFINITION),
        'C:\\$&\\$1\\new.exe'
      );
      expect(programFromTaskAction('powershell.exe', updated)).toBe('C:\\$&\\$1\\new.exe');
    });
  });
});

describe('currentUserName', () => {
  // `loginctl enable-linger <user>` decides whether the unit survives logout.
  // A detached hub carries none of the login-shell variables, so reading them
  // alone named a user that does not exist and linger was never enabled — while
  // the page reported the service installed.
  it('names the account this process runs as, not a login-shell variable', () => {
    expect(currentUserName({})).toBe(userInfo().username);
  });

  it('falls back to the environment only when there is no passwd entry to read', () => {
    expect(currentUserName({ USER: 'shell-user' })).toBe(userInfo().username);
  });
});

describe('defaultUserServiceExecDeps', () => {
  // `Bun.spawn` throws for a program that is not on PATH. Every caller in the
  // manager reads an exit code, so letting that out turned one absent
  // `loginctl` or `which` — a container image without them — into a rejected
  // `status()`, which is a 500 on the machine page and a stack trace out of
  // `service status`.
  it('answers a missing program with an exit code instead of throwing', async () => {
    const result = await defaultUserServiceExecDeps().exec(['mangostudio-no-such-program-xyz']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('mangostudio-no-such-program-xyz');
  });

  it('reads systemd off PATH without spawning anything', async () => {
    expect(await defaultUserServiceExecDeps({ PATH: '/nonexistent' }).hasSystemd()).toBe(false);
  });

  // The unit carries this hub's configuration. `writeFile`'s `mode` is honoured
  // only when the file is created, so a reinstall over a unit an older build
  // left world-readable kept it that way. Windows has no mode to assert on; the
  // supervisor there is a Scheduled Task, not a file.
  it.skipIf(process.platform === 'win32')(
    'tightens an existing unit file to 0600 rather than leaving its old mode',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'mango-unit-'));
      try {
        const path = join(dir, 'example.service');
        await writeFile(path, 'old', { mode: 0o644 });
        await chmod(path, 0o644);

        await defaultUserServiceExecDeps().writeFile(path, 'new');

        expect((await stat(path)).mode & 0o777).toBe(0o600);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
});

describe('createUserServiceManager elsewhere', () => {
  it('reports unsupported without running anything', async () => {
    const host = new FakeServiceHost({ platform: 'freebsd' });
    const status = await createUserServiceManager(IDENTITY, host.deps()).status();
    expect(status).toMatchObject({ platform: 'unsupported', installed: false });
    expect(host.argv).toEqual([]);
    await expect(
      createUserServiceManager(IDENTITY, host.deps()).install(DEFINITION)
    ).rejects.toMatchObject({
      kind: 'runtime_service_unsupported',
    });
  });
});
