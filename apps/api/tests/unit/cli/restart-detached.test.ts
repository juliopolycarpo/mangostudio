import { describe, expect, it } from 'bun:test';

import { spawnDetached } from '../../../src/cli/detach';
import {
  readRestartTargetVersion,
  type RestartDetachedDeps,
  restartDetachedHub,
} from '../../../src/cli/restart-detached';
import {
  detectInstallOrigin,
  restartLauncher,
} from '../../../src/modules/updates/domain/install-origin';
import {
  FakeUpgradedInstall,
  PREVIOUS_HUB_PID,
  PREVIOUS_VERSION,
  UPGRADED_VERSION,
} from '../../support/mocks/fake-upgraded-install';
import { probe } from '../modules/updates/support/install-origin-probes';

/** The deps a real restart gets, with the machine replaced by `install`. */
function restartDepsFor(install: FakeUpgradedInstall): RestartDetachedDeps {
  return {
    stop: install.stop,
    spawnDetached: (port, host, _deps, options) =>
      spawnDetached(port, host, install.detachDeps(), options),
    readTargetVersion: (argv) => readRestartTargetVersion(argv, install.spawnTarget),
  };
}

interface ManagerScenario {
  readonly name: string;
  readonly platform: NodeJS.Platform;
  /** The path this (old) process runs from. */
  readonly execPath: string;
  readonly probeEnv?: Record<string, string>;
  /** What the manager left behind once the upgrade finished. */
  readonly layout: (install: FakeUpgradedInstall) => void;
  /** The path the restart must exec; undefined means this process's own path. */
  readonly restartsThrough: string | undefined;
}

const HOMEBREW_EXEC = '/opt/homebrew/Cellar/mangostudio/0.1.1/libexec/mangostudio';
const PNPM_EXEC =
  '/home/j/.local/share/pnpm/global/5/.pnpm/@mangostudio+cli-linux-x64@0.1.1/node_modules/@mangostudio/cli-linux-x64/mangostudio';
const PNPM_WRAPPER =
  '/home/j/.local/share/pnpm/global/5/.pnpm/mangostudio@0.1.1/node_modules/mangostudio/bin/mangostudio.js';
const SCOOP_EXEC = 'C:\\Users\\j\\scoop\\apps\\mangostudio\\0.1.1\\mangostudio.exe';
const SCOOP_CURRENT = 'C:\\Users\\j\\scoop\\apps\\mangostudio\\current\\mangostudio.exe';
const NPM_EXEC = '/usr/local/lib/node_modules/@mangostudio/cli-linux-x64/mangostudio';
const BUN_EXEC = '/home/j/.bun/install/global/node_modules/@mangostudio/cli-linux-x64/mangostudio';
const CARGO_SHIM = '/home/j/.cargo/bin/mangostudio';
const CARGO_SHIM_WINDOWS = 'C:\\Users\\j\\.cargo\\bin\\mangostudio.exe';

const SCENARIOS: readonly ManagerScenario[] = [
  {
    // The platform package's path has no version, so npm replaced the binary in place.
    name: 'npm',
    platform: 'linux',
    execPath: NPM_EXEC,
    probeEnv: {
      MANGOSTUDIO_LAUNCHER: 'npm',
      MANGOSTUDIO_LAUNCHER_PATH: '/usr/local/lib/node_modules/mangostudio/bin/mangostudio.js',
    },
    layout: (install) => install.place(NPM_EXEC, UPGRADED_VERSION),
    restartsThrough: undefined,
  },
  {
    name: 'bun',
    platform: 'linux',
    execPath: BUN_EXEC,
    probeEnv: {
      MANGOSTUDIO_LAUNCHER: 'npm',
      MANGOSTUDIO_LAUNCHER_PATH:
        '/home/j/.bun/install/global/node_modules/mangostudio/bin/mangostudio.js',
    },
    layout: (install) => install.place(BUN_EXEC, UPGRADED_VERSION),
    restartsThrough: undefined,
  },
  {
    // The version directory is still on disk here: the old build is one
    // `exec` away, which is the bug.
    name: 'pnpm (the shim supervises the binary)',
    platform: 'linux',
    execPath: PNPM_EXEC,
    probeEnv: { MANGOSTUDIO_LAUNCHER: 'npm', MANGOSTUDIO_LAUNCHER_PATH: PNPM_WRAPPER },
    layout: (install) =>
      install
        .place(PNPM_EXEC, PREVIOUS_VERSION)
        .place('/home/j/.local/share/pnpm/mangostudio', UPGRADED_VERSION, {
          supervisesBinary: true,
        }),
    restartsThrough: '/home/j/.local/share/pnpm/mangostudio',
  },
  {
    // `brew cleanup` removed the old Cellar entry; the prefix symlink was relinked.
    name: 'homebrew',
    platform: 'darwin',
    execPath: HOMEBREW_EXEC,
    layout: (install) => install.place('/opt/homebrew/bin/mangostudio', UPGRADED_VERSION),
    restartsThrough: '/opt/homebrew/bin/mangostudio',
  },
  {
    name: 'scoop',
    platform: 'win32',
    execPath: SCOOP_EXEC,
    layout: (install) =>
      install.place(SCOOP_EXEC, PREVIOUS_VERSION).place(SCOOP_CURRENT, UPGRADED_VERSION),
    restartsThrough: SCOOP_CURRENT,
  },
  {
    name: 'cargo on Unix (the shim execs in place)',
    platform: 'linux',
    execPath: '/home/j/.mango/dist/0.1.1/mangostudio',
    probeEnv: { MANGOSTUDIO_LAUNCHER: 'cargo', MANGOSTUDIO_LAUNCHER_PATH: CARGO_SHIM },
    layout: (install) => install.place(CARGO_SHIM, UPGRADED_VERSION),
    restartsThrough: CARGO_SHIM,
  },
  {
    name: 'cargo on Windows (the shim supervises the binary)',
    platform: 'win32',
    execPath: 'C:\\Users\\j\\.cargo\\mangostudio\\0.1.1\\mangostudio.exe',
    probeEnv: { MANGOSTUDIO_LAUNCHER: 'cargo', MANGOSTUDIO_LAUNCHER_PATH: CARGO_SHIM_WINDOWS },
    layout: (install) =>
      install.place(CARGO_SHIM_WINDOWS, UPGRADED_VERSION, { supervisesBinary: true }),
    restartsThrough: CARGO_SHIM_WINDOWS,
  },
];

function launcherFor(scenario: ManagerScenario, install: FakeUpgradedInstall): string | undefined {
  const origin = detectInstallOrigin(
    probe({
      platform: scenario.platform,
      execPath: scenario.execPath,
      env: scenario.probeEnv ?? {},
      localAppData: 'C:\\Users\\j\\AppData\\Local',
    })
  );
  return restartLauncher(origin, {
    platform: scenario.platform,
    execPath: scenario.execPath,
    pathExists: install.pathExists,
  });
}

describe('restartDetachedHub after a delegated upgrade', () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      it('comes back on the build the manager installed', async () => {
        const install = new FakeUpgradedInstall(scenario.execPath);
        scenario.layout(install);
        const launcherPath = launcherFor(scenario, install);

        const result = await restartDetachedHub(
          {
            state: install.previousHub,
            executable: { pointer: 'versioned', argv: [scenario.execPath] },
            launcherPath,
          },
          restartDepsFor(install)
        );

        expect({
          launcher: launcherPath,
          version: install.runningVersion(),
          spawned: install.spawnedArgv[0]?.[0],
        }).toEqual({
          launcher: scenario.restartsThrough,
          version: UPGRADED_VERSION,
          spawned: scenario.restartsThrough ?? scenario.execPath,
        });
        // The pid reported is the hub's, whether or not a launcher stood in front of it.
        expect(result.pid).toBe(install.runningPid() ?? -1);
        expect(install.stoppedPids).toEqual([PREVIOUS_HUB_PID]);
      });

      it('fails clearly and leaves the old hub running when the launcher cannot run', async () => {
        if (scenario.restartsThrough === undefined) return;
        const install = new FakeUpgradedInstall(scenario.execPath);
        scenario.layout(install);
        // The launcher is on disk (so it is offered) but the new build behind it is broken.
        install.place(scenario.restartsThrough, UPGRADED_VERSION, { broken: true });
        const launcherPath = launcherFor(scenario, install);

        const attempt = restartDetachedHub(
          {
            state: install.previousHub,
            executable: { pointer: 'versioned', argv: [scenario.execPath] },
            launcherPath,
          },
          restartDepsFor(install)
        );

        await expect(attempt).rejects.toThrow(
          `Cannot run "${scenario.restartsThrough} --version" (exited with code 1); the running hub was not stopped.`
        );
        expect({
          stopped: install.stoppedPids,
          running: install.runningVersion(),
          oldHubAlive: install.isAlive(PREVIOUS_HUB_PID),
          spawned: install.spawnedArgv.length,
        }).toEqual({
          stopped: [],
          running: PREVIOUS_VERSION,
          oldHubAlive: true,
          spawned: 0,
        });
      });
    });
  }

  it('reports a launcher that vanished before the check, with the old hub still running', async () => {
    const install = new FakeUpgradedInstall(HOMEBREW_EXEC);

    const attempt = restartDetachedHub(
      {
        state: install.previousHub,
        executable: { pointer: 'versioned', argv: [HOMEBREW_EXEC] },
        launcherPath: '/opt/homebrew/bin/mangostudio',
      },
      restartDepsFor(install)
    );

    await expect(attempt).rejects.toThrow(
      'Cannot run "/opt/homebrew/bin/mangostudio --version" (spawn /opt/homebrew/bin/mangostudio ENOENT); the running hub was not stopped.'
    );
    expect(install.isAlive(PREVIOUS_HUB_PID)).toBe(true);
    expect(install.stoppedPids).toEqual([]);
  });

  it('does not check anything when no launcher applies, keeping a non-delegated restart as it was', async () => {
    const install = new FakeUpgradedInstall(NPM_EXEC).place(NPM_EXEC, UPGRADED_VERSION);

    await restartDetachedHub(
      {
        state: install.previousHub,
        executable: { pointer: 'versioned', argv: [NPM_EXEC] },
      },
      restartDepsFor(install)
    );

    expect(install.versionProbes).toEqual([]);
  });
});

describe('readRestartTargetVersion', () => {
  it('returns the version the launcher prints', async () => {
    const install = new FakeUpgradedInstall('/x').place('/opt/homebrew/bin/mangostudio', '0.1.2');

    await expect(
      readRestartTargetVersion(['/opt/homebrew/bin/mangostudio'], install.spawnTarget)
    ).resolves.toBe('0.1.2');
    expect(install.versionProbes).toEqual([['/opt/homebrew/bin/mangostudio']]);
  });

  it('names the launcher when it cannot be spawned', async () => {
    const install = new FakeUpgradedInstall('/x');

    await expect(
      readRestartTargetVersion(['/gone/mangostudio'], install.spawnTarget)
    ).rejects.toThrow(
      'Cannot run "/gone/mangostudio --version" (spawn /gone/mangostudio ENOENT); the running hub was not stopped.'
    );
  });

  it('names the exit code when the launcher fails', async () => {
    const install = new FakeUpgradedInstall('/x').place('/bin/broken', '0.1.2', { broken: true });

    await expect(readRestartTargetVersion(['/bin/broken'], install.spawnTarget)).rejects.toThrow(
      'Cannot run "/bin/broken --version" (exited with code 1)'
    );
  });
});
