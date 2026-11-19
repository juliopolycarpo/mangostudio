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
 * manager reads back. It cannot run PowerShell, but a retarget script only
 * stores the arguments the manager computed, so the host records the script
 * (`retargetScripts`) and keeps those arguments for the next status read.
 */
export class FakeUnitHost {
  readonly files = new Map<string, string>();
  /** Every supervisor command in order, a PowerShell script shown decoded. */
  readonly commands: string[] = [];
  readonly retargetScripts: string[] = [];
  taskArguments: string | null = null;
  /** Backoffs the manager asked for; none is waited. */
  readonly sleeps: number[] = [];
  /** Whether launchd has the job in its domain; bootout drops it, bootstrap loads it. */
  jobLoaded = false;
  /** How many `launchctl print` calls still list a job after its bootout, as one that is exiting does. */
  lingerAfterBootout = 0;
  private lingeringPrints = 0;
  private readonly launchctlFailures = new Map<string, UserServiceExecResult[]>();

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
      sleep: (ms) => {
        this.sleeps.push(ms);
        return Promise.resolve();
      },
    };
  }

  /** The only unit file written, or null when none was. */
  unitBody(): string | null {
    return [...this.files.values()][0] ?? null;
  }

  /**
   * Make the next `times` `launchctl <verb>` calls answer `result` instead of
   * succeeding, the way launchd answers error 5 to a bootstrap that races the
   * bootout before it. Every later call succeeds again.
   */
  failLaunchctl(verb: string, result: UserServiceExecResult, times = 1): void {
    const queue = this.launchctlFailures.get(verb) ?? [];
    for (let i = 0; i < times; i += 1) queue.push(result);
    this.launchctlFailures.set(verb, queue);
  }

  private run(argv: readonly string[]): UserServiceExecResult {
    const ok = (stdout = ''): UserServiceExecResult => ({ exitCode: 0, stdout, stderr: '' });
    const script = decodePowerShellArgv(argv);
    if (script === null) {
      this.commands.push(argv.join(' '));
      return argv[0] === 'launchctl' ? this.runLaunchctl(argv[1] ?? '') : ok();
    }
    this.commands.push(script);
    if (script.includes('Register-ScheduledTask')) {
      this.taskArguments =
        /-Argument '((?:[^']|'')*)'/.exec(script)?.[1]?.replaceAll("''", "'") ?? null;
      return ok();
    }
    if (script.includes('Set-ScheduledTask')) {
      // What a retarget stores: the new action arguments, which the status
      // script then reads back.
      this.retargetScripts.push(script);
      this.taskArguments =
        /\$action\.Arguments = '((?:[^']|'')*)'/.exec(script)?.[1]?.replaceAll("''", "'") ??
        this.taskArguments;
      return ok();
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

  /**
   * launchd's domain, reduced to whether the job is loaded: `kickstart` needs
   * it, `print` reports it, `bootstrap` loads it. After a successful `bootout`
   * the job still shows in `print` for `lingerAfterBootout` calls, the way a job
   * that is exiting does.
   */
  private runLaunchctl(verb: string): UserServiceExecResult {
    const failure = this.launchctlFailures.get(verb)?.shift();
    if (failure) return failure;
    if (verb === 'bootout') {
      this.jobLoaded = false;
      this.lingeringPrints = this.lingerAfterBootout;
    }
    if (verb === 'bootstrap') this.jobLoaded = true;
    if (verb === 'print') {
      if (this.jobLoaded) return { exitCode: 0, stdout: '', stderr: '' };
      if (this.lingeringPrints > 0) {
        this.lingeringPrints -= 1;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: 113, stdout: '', stderr: 'Could not find service in domain' };
    }
    if (verb === 'kickstart' && !this.jobLoaded) {
      return { exitCode: 113, stdout: '', stderr: 'Could not find service in domain' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}
