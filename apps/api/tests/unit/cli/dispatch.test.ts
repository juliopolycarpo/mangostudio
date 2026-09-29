import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  parseDoctorArgs,
  parseEnvArgs,
  parseLibraryArgs,
  parseLogsArgs,
  parseServeArgs,
  parseServiceArgs,
  parseSetupArgs,
  parseStatusArgs,
  parseUpgradeArgs,
} from '../../../src/cli/args';
import { type CommandModules, commandModules, dispatch } from '../../../src/cli/dispatch';
import { printHelp } from '../../../src/cli/usage';
import { embeddedInstaller } from '../../../src/modules/updates/infrastructure/embedded-installers';

describe('dispatch', () => {
  test('turns a CliError into a clean stderr message and exit(1), not a thrown error', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(dispatch(['serve', '--bogus'])).resolves.toBeUndefined();

      expect(stderrSpy).toHaveBeenCalledWith('Unknown option for serve: --bogus\n');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test('still reports the operator error and exits 1 when releasing runtimes also fails', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const failingRelease = () => Promise.reject(new Error('runtime child did not exit'));

    try {
      await expect(dispatch(['status', '--bogus'], failingRelease)).resolves.toBeUndefined();

      expect(stderrSpy).toHaveBeenCalledWith(
        'Could not release runtime connections: runtime child did not exit\n'
      );
      expect(stderrSpy).toHaveBeenCalledWith('Unknown option for status: --bogus\n');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

describe('dispatch service', () => {
  test('routes `service` to the command rather than the unknown-command path', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await dispatch(['service']);
      expect(stderrSpy).toHaveBeenCalledWith(
        'Missing service action. Expected one of: install, uninstall, status, start, stop, restart\n'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

describe('dispatch __installer', () => {
  test('writes the embedded sh installer verbatim to stdout, no newline added, no log prefix', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await dispatch(['__installer', 'sh']);
      expect(stdoutSpy).toHaveBeenCalledWith(embeddedInstaller('sh'));
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  test('writes the embedded ps1 installer verbatim to stdout', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await dispatch(['__installer', 'ps1']);
      expect(stdoutSpy).toHaveBeenCalledWith(embeddedInstaller('ps1'));
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  test('names the two accepted kinds when given anything else', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await dispatch(['__installer', 'bogus']);
      expect(stderrSpy).toHaveBeenCalledWith(
        'Unknown installer kind: bogus. Expected one of: sh, ps1\n'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test('names the two accepted kinds when given none', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await dispatch(['__installer']);
      expect(stderrSpy).toHaveBeenCalledWith('Missing installer kind. Expected one of: sh, ps1\n');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

describe('dispatch env install/update', () => {
  test('routes `env install` through the new subcommand rather than "Unknown env subcommand"', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      // No recipe id: this throws inside `parseEnvArgs` before `runEnvInstall`
      // is even called, so it exercises the routing without needing to fake
      // the install service — proof this is the new branch, not the old
      // "Unknown env subcommand" one `env install` used to fall into.
      await dispatch(['env', 'install']);
      expect(stderrSpy).toHaveBeenCalledWith(
        'Missing recipe id for env install. Usage: env install <recipe> [--environment <id>] [--version <spec>]\n'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test('routes `env update` through the new subcommand the same way', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await dispatch(['env', 'update']);
      expect(stderrSpy).toHaveBeenCalledWith(
        'Missing recipe id for env update. Usage: env update <recipe> [--environment <id>] [--version <spec>]\n'
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

describe('dispatch upgrade/update', () => {
  test('routes `upgrade` to the new command rather than "Unknown command"', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      // An unknown option throws inside parseUpgradeArgs before runUpgrade is
      // even called — proof this is the new branch, not the old
      // "Unknown command: upgrade" default one.
      await dispatch(['upgrade', '--bogus']);
      expect(stderrSpy).toHaveBeenCalledWith('Unknown option for upgrade: --bogus\n');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test('routes the `update` alias the same way', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await dispatch(['update', '--bogus']);
      expect(stderrSpy).toHaveBeenCalledWith('Unknown option for upgrade: --bogus\n');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

describe('dispatch releases runtime connections', () => {
  test('releases them after a command, and before an operator error exits', async () => {
    const order: string[] = [];
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      order.push('exit');
    }) as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const release = () => {
      order.push('release');
      return Promise.resolve();
    };

    try {
      await dispatch(['version'], release);
      await dispatch(['service'], release);
      expect(order).toEqual(['release', 'release', 'exit']);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  // A foreground or re-exec'd server keeps running after its command returns
  // and closes its own connections on shutdown.
  test('leaves them to a server command, which still owns them', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    let released = 0;

    try {
      await dispatch(['serve', '--bogus'], () => {
        released += 1;
        return Promise.resolve();
      });
      expect(released).toBe(0);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

interface HandlerCall {
  readonly handler: string;
  readonly args: unknown;
}

/**
 * Command modules that record which module was loaded and what its handler
 * received, in place of running a real command against this machine. Every
 * handler has the arity and return shape of the one it stands in for; the
 * two with a numeric exit code report 0.
 */
function recordingCommandModules() {
  const loaded: string[] = [];
  const calls: HandlerCall[] = [];
  const load =
    <T>(name: string, module: T) =>
    () => {
      loaded.push(name);
      return Promise.resolve(module);
    };
  const sync = (handler: string) => (args?: unknown) => {
    calls.push({ handler, args });
  };
  const async = (handler: string) => (args?: unknown) => {
    calls.push({ handler, args });
    return Promise.resolve();
  };
  const exitCode = (handler: string) => (args?: unknown) => {
    calls.push({ handler, args });
    return Promise.resolve(0);
  };
  const modules: CommandModules = {
    doctor: load('doctor', { runDoctor: async('runDoctor') }),
    env: load('env', {
      runEnv: async('runEnv'),
      runEnvInstall: exitCode('runEnvInstall'),
      runEnvToolchain: async('runEnvToolchain'),
    }),
    installer: load('installer', { runInstaller: sync('runInstaller') }),
    killserver: load('killserver', { runKillServer: async('runKillServer') }),
    library: load('library', { runLibrary: async('runLibrary') }),
    logs: load('logs', { runLogs: async('runLogs') }),
    open: load('open', { runOpen: async('runOpen') }),
    restart: load('restart', { runRestart: async('runRestart') }),
    serve: load('serve', { runServe: async('runServe') }),
    serveInternal: load('serveInternal', { runServeInternal: async('runServeInternal') }),
    service: load('service', { runService: async('runService') }),
    setup: load('setup', { runSetup: async('runSetup') }),
    status: load('status', { runStatus: async('runStatus') }),
    stop: load('stop', { runStop: async('runStop') }),
    upgrade: load('upgrade', { runUpgrade: exitCode('runUpgrade') }),
    version: load('version', { runVersion: sync('runVersion') }),
  };
  return { modules, loaded, calls };
}

const noRelease = () => Promise.resolve();

interface RouteCase {
  readonly argv: string[];
  readonly module: keyof CommandModules;
  readonly call: HandlerCall;
}

const ROUTES: readonly RouteCase[] = [
  {
    argv: ['setup', '--no-open'],
    module: 'setup',
    call: { handler: 'runSetup', args: parseSetupArgs(['--no-open']) },
  },
  {
    argv: ['serve', '3000'],
    module: 'serve',
    call: { handler: 'runServe', args: parseServeArgs(['3000']) },
  },
  {
    argv: ['__serve', '3000'],
    module: 'serveInternal',
    call: { handler: 'runServeInternal', args: parseServeArgs(['3000']) },
  },
  {
    argv: ['__installer', 'sh'],
    module: 'installer',
    call: { handler: 'runInstaller', args: ['sh'] },
  },
  {
    argv: ['status', '--json'],
    module: 'status',
    call: { handler: 'runStatus', args: parseStatusArgs(['--json']) },
  },
  { argv: ['stop'], module: 'stop', call: { handler: 'runStop', args: undefined } },
  { argv: ['restart'], module: 'restart', call: { handler: 'runRestart', args: undefined } },
  {
    argv: ['killserver'],
    module: 'killserver',
    call: { handler: 'runKillServer', args: undefined },
  },
  {
    argv: ['service', 'status'],
    module: 'service',
    call: { handler: 'runService', args: parseServiceArgs(['status']) },
  },
  {
    argv: ['logs', '-n', '5'],
    module: 'logs',
    call: { handler: 'runLogs', args: parseLogsArgs(['-n', '5']) },
  },
  { argv: ['open'], module: 'open', call: { handler: 'runOpen', args: undefined } },
  {
    argv: ['doctor', '--json'],
    module: 'doctor',
    call: { handler: 'runDoctor', args: parseDoctorArgs(['--json']) },
  },
  {
    argv: ['env', 'agents'],
    module: 'env',
    call: { handler: 'runEnv', args: parseEnvArgs(['agents']) },
  },
  {
    argv: ['env', 'install', 'node'],
    module: 'env',
    call: { handler: 'runEnvInstall', args: parseEnvArgs(['install', 'node']) },
  },
  {
    argv: ['env', 'update', 'node'],
    module: 'env',
    call: { handler: 'runEnvInstall', args: parseEnvArgs(['update', 'node']) },
  },
  {
    argv: ['env', 'toolchain'],
    module: 'env',
    call: { handler: 'runEnvToolchain', args: parseEnvArgs(['toolchain']) },
  },
  {
    argv: ['library', '--json'],
    module: 'library',
    call: { handler: 'runLibrary', args: parseLibraryArgs(['--json']) },
  },
  {
    argv: ['upgrade', '--check'],
    module: 'upgrade',
    call: { handler: 'runUpgrade', args: parseUpgradeArgs(['--check']) },
  },
  {
    argv: ['update', '--check'],
    module: 'upgrade',
    call: { handler: 'runUpgrade', args: parseUpgradeArgs(['--check']) },
  },
  { argv: ['version'], module: 'version', call: { handler: 'runVersion', args: undefined } },
  { argv: ['-v'], module: 'version', call: { handler: 'runVersion', args: undefined } },
  { argv: ['--version'], module: 'version', call: { handler: 'runVersion', args: undefined } },
];

describe('dispatch loads only the selected command', () => {
  const exitCodeBefore = process.exitCode;
  afterEach(() => {
    process.exitCode = exitCodeBefore;
  });

  test.each(ROUTES.map((route) => [route.argv.join(' '), route] as const))(
    '`%s` loads its own module and calls its handler with the parsed args',
    async (_label, route) => {
      const { modules, loaded, calls } = recordingCommandModules();

      await dispatch(route.argv, noRelease, modules);

      expect({ loaded, calls }).toEqual({ loaded: [route.module], calls: [route.call] });
    }
  );

  test('a mistyped flag is refused before its command module loads', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { modules, loaded, calls } = recordingCommandModules();

    try {
      await dispatch(['doctor', '--bogus'], noRelease, modules);
      expect({ loaded, calls }).toEqual({ loaded: [], calls: [] });
      expect(stderrSpy).toHaveBeenCalledWith('Unknown option for doctor: --bogus\n');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  test('every real loader resolves the handlers its command calls', async () => {
    const handlers: Record<keyof CommandModules, readonly string[]> = {
      doctor: ['runDoctor'],
      env: ['runEnv', 'runEnvInstall', 'runEnvToolchain'],
      installer: ['runInstaller'],
      killserver: ['runKillServer'],
      library: ['runLibrary'],
      logs: ['runLogs'],
      open: ['runOpen'],
      restart: ['runRestart'],
      serve: ['runServe'],
      serveInternal: ['runServeInternal'],
      service: ['runService'],
      setup: ['runSetup'],
      status: ['runStatus'],
      stop: ['runStop'],
      upgrade: ['runUpgrade'],
      version: ['runVersion'],
    };
    const missing: string[] = [];
    for (const [name, names] of Object.entries(handlers)) {
      const loaded: Record<string, unknown> = await commandModules[name as keyof CommandModules]();
      missing.push(...names.filter((handler) => typeof loaded[handler] !== 'function'));
    }
    expect(missing).toEqual([]);
  });
});

describe('dispatch help and unknown commands', () => {
  function capturedHelp(): string {
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      printHelp();
      return String(stdoutSpy.mock.calls[0]?.[0]);
    } finally {
      stdoutSpy.mockRestore();
    }
  }

  test.each([[[]], [['help']], [['-h']], [['--help']]])(
    '%p prints the help text and loads no command module',
    async (argv) => {
      const help = capturedHelp();
      const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
      const { modules, loaded } = recordingCommandModules();

      try {
        await dispatch(argv, noRelease, modules);
        expect(stdoutSpy.mock.calls).toEqual([[help]]);
        expect(loaded).toEqual([]);
      } finally {
        stdoutSpy.mockRestore();
      }
    }
  );

  test('an unknown command names itself on stderr, prints help and exits 1', async () => {
    const help = capturedHelp();
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { modules, loaded } = recordingCommandModules();

    try {
      await dispatch(['bogus'], noRelease, modules);
      expect(stderrSpy.mock.calls).toEqual([['Unknown command: bogus\n']]);
      expect(stdoutSpy.mock.calls).toEqual([[help]]);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(loaded).toEqual([]);
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
