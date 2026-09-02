import { describe, expect, it } from 'bun:test';
import { UserServiceStatusSchema } from '@mangostudio/shared/runtime-home';
import Value from 'typebox/value';
import {
  createUserServiceManager,
  decodePowerShellArgv,
  execPathFromUnitBody,
  parseScheduledTaskJson,
  programFromTaskAction,
  renderLaunchdPlistFile,
  renderScheduledTaskInstallScript,
  renderScheduledTaskRunnerScript,
  renderSystemdUnitFile,
  type UserServiceDefinition,
  type UserServiceExecDeps,
  type UserServiceExecResult,
  type UserServiceIdentity,
} from '../../../src/services/user-service-manager';

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

  constructor(
    private readonly options: {
      readonly platform?: NodeJS.Platform;
      readonly hasSystemd?: boolean;
      readonly env?: NodeJS.ProcessEnv;
      readonly busSocket?: boolean;
      readonly onExec?: (argv: readonly string[]) => UserServiceExecResult | undefined;
    } = {}
  ) {}

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
      hasSystemd: () => Promise.resolve(this.options.hasSystemd ?? true),
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
      pathExists: (path) =>
        Promise.resolve(path.endsWith('/bus') ? (this.options.busSocket ?? true) : true),
      warn: (message) => {
        this.warnings.push(message);
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
  });

  it('reads the state name from both PowerShell 5.1 and 7 JSON', () => {
    expect(parseScheduledTaskJson('{"installed":true,"state":4,"enabled":true}')?.state).toBe(
      'Running'
    );
    expect(parseScheduledTaskJson('{"installed":true,"state":"Ready","enabled":true}')?.state).toBe(
      'Ready'
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

  it('bootstraps before kickstarting on restart, so a stopped job comes back', async () => {
    const host = new FakeServiceHost({ platform: 'darwin' });

    await createUserServiceManager(IDENTITY, host.deps()).restart();

    // `stop` boots the job out of the domain, so `kickstart` alone would fail
    // with "Could not find service" while the CLI reported a restart. systemd
    // and Task Scheduler both start a stopped unit on restart.
    expect(host.argv).toEqual([
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
    const host = new FakeServiceHost({ platform: 'darwin' });

    await createUserServiceManager(IDENTITY, host.deps()).start();

    expect(host.argv).toEqual([
      [
        'launchctl',
        'bootstrap',
        'gui/1000',
        '/home/test/Library/LaunchAgents/com.example.unit.plist',
      ],
      ['launchctl', 'kickstart', 'gui/1000/com.example.unit'],
    ]);
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
