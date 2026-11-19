import {
  decodePowerShellArgv,
  type UserServiceExecDeps,
  type UserServiceExecResult,
} from '@mangostudio/shared/machine/service';

/**
 * The files and supervisor commands behind a real `createUserServiceManager`,
 * kept in memory: nothing here talks to systemd, launchd or Task Scheduler.
 *
 * On systemd and launchd the unit file is a real file in `files`, so a test
 * reads back what the manager wrote. Task Scheduler keeps no file: the host
 * remembers the `-Argument` the install script registered (`taskArguments`)
 * and answers the status script with it, which is the one thing the real
 * manager reads back. It cannot run PowerShell, so a retarget script is only
 * recorded (`retargetScripts`) and answered `retargeted`.
 */
export class FakeUnitHost {
  readonly files = new Map<string, string>();
  /** Every supervisor command in order, a PowerShell script shown decoded. */
  readonly commands: string[] = [];
  readonly retargetScripts: string[] = [];
  taskArguments: string | null = null;

  constructor(readonly platform: 'linux' | 'darwin' | 'win32') {}

  deps(): UserServiceExecDeps {
    return {
      exec: (argv) => Promise.resolve(this.run(argv)),
      platform: this.platform,
      env: {
        XDG_RUNTIME_DIR: '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      },
      home: '/home/test',
      uid: 1000,
      user: 'test',
      hasSystemd: () => Promise.resolve(true),
      writeFile: (path, contents) => {
        this.files.set(path, contents);
        return Promise.resolve();
      },
      readFile: (path) => {
        const body = this.files.get(path);
        return body === undefined
          ? Promise.reject(new Error(`ENOENT ${path}`))
          : Promise.resolve(body);
      },
      unlink: (path) => {
        this.files.delete(path);
        return Promise.resolve();
      },
      mkdir: () => Promise.resolve(),
      pathExists: () => Promise.resolve(true),
      warn: () => undefined,
    };
  }

  /** The only unit file written, or null when none was. */
  unitBody(): string | null {
    return [...this.files.values()][0] ?? null;
  }

  private run(argv: readonly string[]): UserServiceExecResult {
    const ok = (stdout = ''): UserServiceExecResult => ({ exitCode: 0, stdout, stderr: '' });
    const script = decodePowerShellArgv(argv);
    if (script === null) {
      this.commands.push(argv.join(' '));
      return ok();
    }
    this.commands.push(script);
    if (script.includes('Register-ScheduledTask')) {
      this.taskArguments =
        /-Argument '((?:[^']|'')*)'/.exec(script)?.[1]?.replaceAll("''", "'") ?? null;
      return ok();
    }
    if (script.includes('Set-ScheduledTask')) {
      this.retargetScripts.push(script);
      return ok('retargeted\n');
    }
    if (script.includes('ConvertTo-Json')) {
      return ok(
        `${JSON.stringify({
          installed: this.taskArguments !== null,
          state: 3,
          enabled: true,
          execute: 'powershell.exe',
          arguments: this.taskArguments,
          lastResult: 0,
        })}\n`
      );
    }
    return ok();
  }
}
