import { describe, expect, it } from 'bun:test';

import {
  createUserServiceManager,
  renderLaunchdRetargetHelperPlistFile,
  type UserServiceManager,
} from '@mangostudio/shared/machine/service';

import { buildHubServiceDefinition } from '../../../../src/modules/machine/application/hub-service';
import { HUB_SERVICE_IDENTITY } from '../../../../src/modules/machine/domain/hub-service-identity';
import { FakeUnitHost } from '../../../support/mocks/fake-unit-host';

const LAUNCHER = '/opt/homebrew/bin/mangostudio';
const LOG_FILE = '/Users/test/.mango/logs/service-retarget.log';
const HELPER_LABEL = 'com.mangostudio.hub.retarget';
/** The hub's run directory: state the hub owns, not a place launchd scans at login. */
const STATE_DIR = '/home/test/.mango/run';
const HELPER_PLIST = `${STATE_DIR}/${HELPER_LABEL}.plist`;
const HUB_PLIST = '/home/test/Library/LaunchAgents/com.mangostudio.hub.plist';
const HELPER_TARGET = `gui/1000/${HELPER_LABEL}`;
const HUB_TARGET = 'gui/1000/com.mangostudio.hub';

/** A darwin host with the hub's own unit installed, the way `service install` leaves it. */
async function darwinHostWithHub(): Promise<{ host: FakeUnitHost; manager: UserServiceManager }> {
  const host = new FakeUnitHost('darwin');
  const manager = createUserServiceManager(HUB_SERVICE_IDENTITY, host.deps(), {
    retargetHelperDir: STATE_DIR,
  });
  await manager.install(
    buildHubServiceDefinition({
      executable: {
        argv: ['/opt/homebrew/Cellar/mangostudio/0.1.1/libexec/mangostudio'],
        pointer: 'external',
      },
      unitName: 'com.mangostudio.hub',
      logFile: '/Users/test/.mango/logs/service.log',
      env: { PATH: '/opt/homebrew/bin:/usr/bin', MANGO_HOME: '/Users/test/mango-data' },
      platform: 'darwin',
    })
  );
  host.commands.length = 0;
  return { host, manager };
}

describe('the launchd retarget helper', () => {
  it('writes a one-shot agent that runs `<launcher> restart` and outlives the hub job', async () => {
    const { host, manager } = await darwinHostWithHub();

    await manager.startRetargetHelper(LAUNCHER, LOG_FILE);

    const plist = host.files.get(HELPER_PLIST) ?? '';
    expect(plist).toContain(`<key>Label</key>\n  <string>${HELPER_LABEL}</string>`);
    expect(plist).toContain(
      `<key>ProgramArguments</key>\n  <array>\n    <string>${LAUNCHER}</string>\n    <string>restart</string>\n  </array>`
    );
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    // The helper's own bootout must not take down what it started.
    expect(plist).toContain('<key>AbandonProcessGroup</key>\n  <true/>');
    // One-shot: nothing may start it again after it exits.
    expect(plist).not.toContain('KeepAlive');
    expect(plist).toContain(`<key>StandardOutPath</key>\n  <string>${LOG_FILE}</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key>\n  <string>${LOG_FILE}</string>`);
  });

  it("runs with the hub unit's environment, so `restart` reads the same data directory", async () => {
    const { host, manager } = await darwinHostWithHub();

    await manager.startRetargetHelper(LAUNCHER, LOG_FILE);

    const plist = host.files.get(HELPER_PLIST) ?? '';
    expect(plist).toContain('<key>MANGO_HOME</key>\n    <string>/Users/test/mango-data</string>');
    expect(plist).toContain('<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin</string>');
  });

  it('bootstraps the helper into the user domain and leaves the hub job alone', async () => {
    const { host, manager } = await darwinHostWithHub();

    await manager.startRetargetHelper(LAUNCHER, LOG_FILE);

    // RunAtLoad starts it: no kickstart is needed, and a bootout or kickstart
    // of the hub's job from here would be the very restart it exists to avoid.
    expect(host.commands).toEqual([`launchctl bootstrap gui/1000 ${HELPER_PLIST}`]);
    expect(host.commands.join('\n')).not.toContain(HUB_TARGET);
    // The hub's own plist is untouched.
    expect(host.files.get(HUB_PLIST)).toContain('Cellar/mangostudio/0.1.1');
  });

  it('removes a leftover helper before loading a new one, so the bootstrap is not refused as loaded', async () => {
    const { host, manager } = await darwinHostWithHub();
    await manager.startRetargetHelper(LAUNCHER, LOG_FILE);
    host.commands.length = 0;

    await manager.startRetargetHelper(LAUNCHER, LOG_FILE);

    expect(host.commands).toEqual([
      `launchctl bootout ${HELPER_TARGET}`,
      `launchctl bootstrap gui/1000 ${HELPER_PLIST}`,
    ]);
  });

  it('removes the plist and boots the job out when the helper is cleaned up', async () => {
    const { host, manager } = await darwinHostWithHub();
    await manager.startRetargetHelper(LAUNCHER, LOG_FILE);
    host.commands.length = 0;

    await manager.removeRetargetHelper();

    expect(host.files.has(HELPER_PLIST)).toBe(false);
    expect(host.commands).toEqual([`launchctl bootout ${HELPER_TARGET}`]);
    // Only the helper: the hub's unit stays installed and loaded.
    expect(host.files.has(HUB_PLIST)).toBe(true);
  });

  it('unlinks the plist before the bootout, which ends the process when the helper removes itself', async () => {
    const { host, manager } = await darwinHostWithHub();
    await manager.startRetargetHelper(LAUNCHER, LOG_FILE);
    const order: string[] = [];
    const deps = host.deps();
    const manager2 = createUserServiceManager(
      HUB_SERVICE_IDENTITY,
      {
        ...deps,
        unlink: (path) => {
          order.push(`unlink ${path}`);
          return deps.unlink(path);
        },
        exec: (argv, options) => {
          order.push(argv.join(' '));
          return deps.exec(argv, options);
        },
      },
      { retargetHelperDir: STATE_DIR }
    );

    await manager2.removeRetargetHelper();

    expect(order).toEqual([`unlink ${HELPER_PLIST}`, `launchctl bootout ${HELPER_TARGET}`]);
  });

  it('does nothing when no helper was left behind', async () => {
    const { host, manager } = await darwinHostWithHub();

    await manager.removeRetargetHelper();

    expect(host.commands).toEqual([]);
  });

  it('removes the plist and reports the refusal when the bootstrap fails', async () => {
    const { host, manager } = await darwinHostWithHub();
    host.failLaunchctl('bootstrap', {
      exitCode: 1,
      stdout: '',
      stderr: 'Load failed: 1: Input/output error',
    });

    await expect(manager.startRetargetHelper(LAUNCHER, LOG_FILE)).rejects.toMatchObject({
      message:
        'launchctl bootstrap (retarget helper) failed (exit 1): Load failed: 1: Input/output error',
    });

    expect(host.files.has(HELPER_PLIST)).toBe(false);
  });

  // launchd loads every plist in ~/Library/LaunchAgents at login, and this one
  // runs `restart`. Anywhere else, a leftover from a missed cleanup is inert.
  it('keeps the plist outside LaunchAgents, so a leftover cannot run `restart` at login', async () => {
    const { host, manager } = await darwinHostWithHub();

    await manager.startRetargetHelper(LAUNCHER, LOG_FILE);

    const helperPaths = [...host.files.keys()].filter((path) => path.endsWith('.retarget.plist'));
    expect(helperPaths).toEqual([HELPER_PLIST]);
    expect(helperPaths.join('\n')).not.toContain('LaunchAgents');
    // Loaded from where it is: launchctl takes any path.
    expect(host.commands).toEqual([`launchctl bootstrap gui/1000 ${HELPER_PLIST}`]);
  });

  it('refuses to start a helper without a state directory to keep its plist in', async () => {
    const host = new FakeUnitHost('darwin');
    const manager = createUserServiceManager(HUB_SERVICE_IDENTITY, host.deps());

    await expect(manager.startRetargetHelper(LAUNCHER, LOG_FILE)).rejects.toMatchObject({
      message: expect.stringContaining('No state directory'),
    });

    // Never falls back to LaunchAgents.
    expect(host.files.size).toBe(0);
    expect(host.commands).toEqual([]);
  });

  it('is only for launchd: another platform neither starts nor has anything to remove', async () => {
    const host = new FakeUnitHost('linux');
    const manager = createUserServiceManager(HUB_SERVICE_IDENTITY, host.deps(), {
      retargetHelperDir: STATE_DIR,
    });

    await manager.removeRetargetHelper();
    await expect(manager.startRetargetHelper(LAUNCHER, LOG_FILE)).rejects.toMatchObject({
      message: expect.stringContaining('only on macOS'),
    });

    expect(host.commands).toEqual([]);
    expect(host.files.size).toBe(0);
  });
});

describe('renderLaunchdRetargetHelperPlistFile', () => {
  it('escapes the launcher, log path and environment values', () => {
    const plist = renderLaunchdRetargetHelperPlistFile(HELPER_LABEL, {
      argv: ['/Users/a&b/<bin>/mangostudio', 'restart'],
      env: { NOTE: 'a "quoted" & <tagged> value' },
      logFile: '/Users/a&b/log.txt',
    });

    expect(plist).toContain('<string>/Users/a&amp;b/&lt;bin&gt;/mangostudio</string>');
    expect(plist).toContain('<string>a &quot;quoted&quot; &amp; &lt;tagged&gt; value</string>');
    expect(plist).toContain('<string>/Users/a&amp;b/log.txt</string>');
  });

  it('omits the environment block when there is nothing to carry', () => {
    const plist = renderLaunchdRetargetHelperPlistFile(HELPER_LABEL, {
      argv: [LAUNCHER, 'restart'],
      env: {},
      logFile: LOG_FILE,
    });

    expect(plist).not.toContain('EnvironmentVariables');
  });
});
