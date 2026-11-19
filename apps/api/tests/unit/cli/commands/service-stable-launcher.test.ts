import { describe, expect, it } from 'bun:test';

import {
  createUserServiceManager,
  decodePowerShellArgv,
  execPathFromUnitBody,
  type UserServiceManager,
} from '@mangostudio/shared/machine/service';
import type { InstallManager } from '@mangostudio/shared/updates';

import { runRestart } from '../../../../src/cli/commands/restart';
import { runService, type ServiceDeps } from '../../../../src/cli/commands/service';
import type { ServerState } from '../../../../src/lib/server-state';
import {
  buildHubServiceDefinition,
  restartHubService,
} from '../../../../src/modules/machine/application/hub-service';
import { HUB_SERVICE_IDENTITY } from '../../../../src/modules/machine/domain/hub-service-identity';
import { restartLauncher } from '../../../../src/modules/updates/domain/install-origin';
import { FakeProcessController } from '../../../../tests/support/mocks/fake-process-controller';
import { FakeUnitHost } from '../../../support/mocks/fake-unit-host';

/**
 * A package manager that puts the version in the path this process runs from:
 * the unit must record the launcher that follows its upgrades instead.
 */
interface ManagedLayout {
  readonly platform: 'linux' | 'darwin' | 'win32';
  readonly manager: InstallManager;
  readonly versioned: string;
  readonly launcher: string;
  /** The version a later upgrade moved the install to. */
  readonly upgradedVersioned: string;
}

const LAYOUTS: readonly ManagedLayout[] = [
  {
    platform: 'linux',
    manager: 'homebrew',
    versioned: '/home/linuxbrew/.linuxbrew/Cellar/mangostudio/0.1.1/libexec/mangostudio',
    launcher: '/home/linuxbrew/.linuxbrew/bin/mangostudio',
    upgradedVersioned: '/home/linuxbrew/.linuxbrew/Cellar/mangostudio/0.1.2/libexec/mangostudio',
  },
  {
    platform: 'darwin',
    manager: 'homebrew',
    versioned: '/opt/homebrew/Cellar/mangostudio/0.1.1/libexec/mangostudio',
    launcher: '/opt/homebrew/bin/mangostudio',
    upgradedVersioned: '/opt/homebrew/Cellar/mangostudio/0.1.2/libexec/mangostudio',
  },
  {
    platform: 'win32',
    manager: 'scoop',
    versioned: 'C:\\Users\\me\\scoop\\apps\\mangostudio\\0.1.1\\mangostudio.exe',
    launcher: 'C:\\Users\\me\\scoop\\apps\\mangostudio\\current\\mangostudio.exe',
    upgradedVersioned: 'C:\\Users\\me\\scoop\\apps\\mangostudio\\0.1.2\\mangostudio.exe',
  },
];

/** The launcher the manager left, as `restartLauncher` resolves it for a process running from `execPath`. */
function launcherFor(layout: ManagedLayout, execPath: string): string | undefined {
  return restartLauncher(
    { manager: layout.manager },
    { platform: layout.platform, execPath, pathExists: () => true }
  );
}

/** The unit as written: the file on systemd and launchd, the runner script inside the task on Windows. */
function unitText(host: FakeUnitHost): string {
  const body = host.unitBody();
  if (body !== null) return body;
  const encoded = /-EncodedCommand\s+(\S+)/.exec(host.taskArguments ?? '')?.[1];
  return decodePowerShellArgv(['-EncodedCommand', encoded ?? '']) ?? '';
}

/** What the unit currently starts, read back the way `service status` reads it. */
async function unitProgram(manager: UserServiceManager): Promise<string | undefined> {
  return (await manager.status()).execPath;
}

function installDeps(
  layout: ManagedLayout,
  manager: UserServiceManager,
  lines: string[]
): Partial<ServiceDeps> {
  return {
    manager,
    controller: new FakeProcessController(),
    readState: () => Promise.resolve(null),
    removeState: () => Promise.resolve(),
    log: (message) => lines.push(message),
    ensureAuthSecret: () => Promise.resolve(),
    secretPersisted: () => true,
    envFilePath: () => '/home/test/.mango/.env',
    configuredTarget: () => ({ host: '127.0.0.1', port: 3001 }),
    assertServeConfig: () => undefined,
    ensureDirs: () => Promise.resolve(),
    // What the process running the install resolves from its own path.
    executable: () => ({ argv: [layout.versioned], pointer: 'external' }),
    launcherPath: () => launcherFor(layout, layout.versioned),
    logFile: () => '/home/test/.mango/logs/service.log',
    platform: layout.platform,
    env: { PATH: '/usr/bin' },
  };
}

/** A unit as a release before this fix wrote it: the versioned path, whatever the manager. */
async function installStaleUnit(layout: ManagedLayout, manager: UserServiceManager): Promise<void> {
  await manager.install(
    buildHubServiceDefinition({
      executable: { argv: [layout.versioned], pointer: 'external' },
      unitName: 'mangostudio.service',
      logFile: '/home/test/.mango/logs/service.log',
      env: { PATH: '/usr/bin', DATABASE_PATH: '/srv/mango/db.sqlite', API_PORT: '4100' },
      platform: layout.platform,
    })
  );
}

describe('service install from a versioned path', () => {
  for (const layout of LAYOUTS) {
    const label = `${layout.platform} (${layout.manager})`;

    it(`${label}: writes the manager's launcher, not the version directory`, async () => {
      const host = new FakeUnitHost(layout.platform);
      const manager = createUserServiceManager(HUB_SERVICE_IDENTITY, host.deps());
      const lines: string[] = [];

      await runService({ action: 'install', json: false }, installDeps(layout, manager, lines));

      expect(await unitProgram(manager)).toBe(layout.launcher);
      expect(unitText(host)).not.toContain(layout.versioned);
      expect(lines.join('\n')).toContain(`Runs:    ${layout.launcher} serve`);
    });
  }

  it('keeps naming the executable when the install has no launcher, as for npm', async () => {
    const [layout] = LAYOUTS;
    if (!layout) throw new Error('no layouts');
    const host = new FakeUnitHost('linux');
    const manager = createUserServiceManager(HUB_SERVICE_IDENTITY, host.deps());

    await runService(
      { action: 'install', json: false },
      { ...installDeps(layout, manager, []), launcherPath: () => undefined }
    );

    expect(await unitProgram(manager)).toBe(layout.versioned);
  });
});

describe('a unit written before the launcher was recorded', () => {
  for (const layout of LAYOUTS) {
    const label = `${layout.platform} (${layout.manager})`;

    it(`${label}: an upgrade moves it onto the launcher before the restart`, async () => {
      const host = new FakeUnitHost(layout.platform);
      const manager = createUserServiceManager(HUB_SERVICE_IDENTITY, host.deps());
      await installStaleUnit(layout, manager);
      expect(await unitProgram(manager)).toBe(layout.versioned);
      host.commands.length = 0;

      await restartHubService(manager, layout.launcher, {
        probe: { platform: layout.platform, pathExists: () => true },
      });

      if (layout.platform === 'win32') {
        expect(host.retargetScripts).toHaveLength(1);
        // The task now reports the launcher, read back through the status script.
        expect(await unitProgram(manager)).toBe(layout.launcher);
        // Retarget first, then the restart script: the restart starts what was rewritten.
        expect(host.commands.findIndex((c) => c.includes('Set-ScheduledTask'))).toBeLessThan(
          host.commands.findIndex((c) => c.includes('Start-ScheduledTask'))
        );
      } else {
        expect(execPathFromUnitBody(host.unitBody() ?? '')).toBe(layout.launcher);
        // The supervisor rereads the rewritten file before the bounce.
        const reread = host.commands.findIndex((c) => /daemon-reload|bootout/.test(c));
        const bounce = host.commands.findIndex((c) => /restart|kickstart/.test(c));
        expect(reread).toBeGreaterThanOrEqual(0);
        expect(reread).toBeLessThan(bounce);
      }
    });
  }

  for (const layout of LAYOUTS.filter((entry) => entry.platform !== 'win32')) {
    it(`${layout.platform}: only the program changes in the rewritten unit`, async () => {
      const host = new FakeUnitHost(layout.platform);
      const manager = createUserServiceManager(HUB_SERVICE_IDENTITY, host.deps());
      await installStaleUnit(layout, manager);
      const before = host.unitBody() ?? '';

      await restartHubService(manager, layout.launcher, {
        probe: { platform: layout.platform, pathExists: () => true },
      });

      expect(host.unitBody()).toBe(before.replace(layout.versioned, layout.launcher));
      expect(host.unitBody()).toContain('/srv/mango/db.sqlite');
      expect(host.unitBody()).toContain('4100');
    });
  }

  it('leaves a unit the operator pointed at another program alone', async () => {
    const [layout] = LAYOUTS;
    if (!layout) throw new Error('no layouts');
    const host = new FakeUnitHost('linux');
    const manager = createUserServiceManager(HUB_SERVICE_IDENTITY, host.deps());
    await manager.install(
      buildHubServiceDefinition({
        executable: { argv: ['/srv/custom/mangostudio'], pointer: 'external' },
        unitName: 'mangostudio.service',
        logFile: '/home/test/.mango/logs/service.log',
        env: {},
        platform: 'linux',
      })
    );

    const moved = await restartHubService(manager, layout.launcher, {
      probe: { platform: 'linux', pathExists: () => true },
    });

    expect(moved).toBeNull();
    expect(await unitProgram(manager)).toBe('/srv/custom/mangostudio');
    // Still bounced, as it was installed.
    expect(host.commands.some((command) => /restart/.test(command))).toBe(true);
  });

  it('leaves a unit that already runs the launcher alone', async () => {
    const [layout] = LAYOUTS;
    if (!layout) throw new Error('no layouts');
    const host = new FakeUnitHost('linux');
    const manager = createUserServiceManager(HUB_SERVICE_IDENTITY, host.deps());
    await runService({ action: 'install', json: false }, installDeps(layout, manager, []));
    const before = host.unitBody();
    host.commands.length = 0;

    const moved = await restartHubService(manager, layout.launcher, {
      probe: { platform: 'linux', pathExists: () => true },
    });

    expect(moved).toBeNull();
    expect(host.unitBody()).toBe(before);
    // Status reads are fine; nothing may reload or unload the unit.
    expect(host.commands.filter((command) => /daemon-reload|bootout/.test(command))).toEqual([]);
  });

  it('moves a unit whose version directory the manager already removed', async () => {
    const [layout] = LAYOUTS;
    if (!layout) throw new Error('no layouts');
    const host = new FakeUnitHost('linux');
    const manager = createUserServiceManager(HUB_SERVICE_IDENTITY, host.deps());
    await installStaleUnit(layout, manager);

    // Only the launcher exists on disk; the Cellar entry the unit names is gone.
    const moved = await restartHubService(manager, layout.launcher, {
      probe: { platform: 'linux', pathExists: (path) => path === layout.launcher },
    });

    expect(moved).toEqual({ from: layout.versioned, to: layout.launcher });
  });

  describe('on launchd, where the job only rereads its plist across a bootout and a bootstrap', () => {
    const DARWIN = LAYOUTS.find((entry) => entry.platform === 'darwin');
    const EIO = { exitCode: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };

    async function staleDarwinUnit(): Promise<{
      host: FakeUnitHost;
      manager: UserServiceManager;
      layout: ManagedLayout;
    }> {
      if (!DARWIN) throw new Error('no darwin layout');
      const host = new FakeUnitHost('darwin');
      const manager = createUserServiceManager(HUB_SERVICE_IDENTITY, host.deps());
      await installStaleUnit(DARWIN, manager);
      host.commands.length = 0;
      return { host, manager, layout: DARWIN };
    }

    it('retries the bootstrap that races the old job still exiting, then kicks the job', async () => {
      const { host, manager, layout } = await staleDarwinUnit();
      host.failLaunchctl('bootstrap', EIO, 2);

      await restartHubService(manager, layout.launcher, {
        probe: { platform: 'darwin', pathExists: () => true },
      });

      expect(host.commands.map((command) => command.split(' ')[1])).toEqual([
        'print', // the status read that finds the stale unit
        'bootout',
        'bootstrap',
        'bootstrap',
        'bootstrap',
        'kickstart',
      ]);
      expect(host.sleeps).toHaveLength(2);
      expect(host.jobLoaded).toBe(true);
      expect(execPathFromUnitBody(host.unitBody() ?? '')).toBe(layout.launcher);
    });

    it('surfaces a bootstrap that never succeeds instead of reporting a restart of an unloaded job', async () => {
      const { host, manager, layout } = await staleDarwinUnit();
      host.failLaunchctl('bootstrap', EIO, 50);

      await expect(
        restartHubService(manager, layout.launcher, {
          probe: { platform: 'darwin', pathExists: () => true },
        })
      ).rejects.toMatchObject({
        message: 'launchctl bootstrap failed (exit 5): Bootstrap failed: 5: Input/output error',
      });

      expect(host.commands.some((command) => command.includes('kickstart'))).toBe(false);
    });
  });
});

describe('mangostudio restart with a stale unit', () => {
  const HUB: ServerState = {
    pid: 42,
    port: 3001,
    host: '127.0.0.1',
    startedAt: 0,
    logFile: '/home/test/.mango/logs/service.log',
    version: '0.1.1',
    service: 'mangostudio.service',
  };

  for (const layout of LAYOUTS) {
    it(`${layout.platform} (${layout.manager}): starts a stopped unit on the launcher after the upgrade`, async () => {
      const host = new FakeUnitHost(layout.platform);
      const manager = createUserServiceManager(HUB_SERVICE_IDENTITY, host.deps());
      await installStaleUnit(layout, manager);
      const lines: string[] = [];
      let now = 0;
      // After the upgrade the CLI runs from the new version's directory.
      const launcher = launcherFor(layout, layout.upgradedVersioned);
      let started = false;

      await runRestart({
        manager,
        controller: new FakeProcessController([43]),
        readState: () => Promise.resolve(started ? { ...HUB, pid: 43 } : null),
        removeState: () => Promise.resolve(),
        confirmsHealthy: () => Promise.resolve(true),
        launcherPath: () => launcher,
        pathExists: () => true,
        platform: layout.platform,
        log: (message) => lines.push(message),
        now: () => now,
        sleep: (ms) => {
          now += ms;
          started = host.commands.some((c) => /start|kickstart/i.test(c));
          return Promise.resolve();
        },
      });

      expect(lines.join('\n')).toContain(
        `Updated the service unit to run ${layout.launcher} (it named ${layout.versioned}).`
      );
      if (layout.platform === 'win32') {
        expect(host.retargetScripts).toHaveLength(1);
        expect(await unitProgram(manager)).toBe(layout.launcher);
      } else {
        expect(execPathFromUnitBody(host.unitBody() ?? '')).toBe(layout.launcher);
      }
    });
  }
});
