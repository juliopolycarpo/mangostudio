import { describe, expect, it } from 'bun:test';
import { INSTALLED_VIA_PATH_MAX } from '@mangostudio/shared/updates';
import {
  detectInstallOrigin,
  fitInstalledVia,
  npmFamilyFromPath,
  parseInstallOriginRecord,
  versionChannel,
} from '../../../../src/modules/updates/domain/install-origin';
import { probe } from './support/install-origin-probes';

const ORIGIN_RECORD = JSON.stringify({
  origin: 'installer',
  channel: 'stable',
  version: '0.1.1',
  previousVersion: '0.1.0',
  installedAt: '2026-09-01T00:00:00Z',
  source: 'github-release',
  futureKey: 'ignored',
});

describe('detectInstallOrigin', () => {
  it('reads the origin record from the dist root', () => {
    const origin = detectInstallOrigin(
      probe({
        readFile: (path) =>
          path === '/home/j/.mango/dist/install-origin.json' ? ORIGIN_RECORD : null,
      })
    );
    expect(origin.manager).toBe('self-managed');
    expect(origin.distRoot).toBe('/home/j/.mango/dist');
    expect(origin.legacy).toBeUndefined();
    expect(origin.record?.previousVersion).toBe('0.1.0');
  });

  it('treats a dist root without a record as a legacy self-managed install', () => {
    const origin = detectInstallOrigin(probe());
    expect(origin.manager).toBe('self-managed');
    expect(origin.legacy).toBe(true);
  });

  it('lets the cargo launcher marker override the shared dist root', () => {
    const origin = detectInstallOrigin(
      probe({
        env: {
          MANGOSTUDIO_LAUNCHER: 'cargo',
          MANGOSTUDIO_LAUNCHER_PATH: '/home/j/.cargo/bin/mangostudio',
        },
      })
    );
    expect(origin.manager).toBe('cargo');
    expect(origin.launcherPath).toBe('/home/j/.cargo/bin/mangostudio');
  });

  it('splits the npm launcher by where the wrapper lives', () => {
    const bunPath = '/home/j/.bun/install/global/node_modules/mangostudio/bin/mangostudio.js';
    expect(
      detectInstallOrigin(
        probe({
          execPath:
            '/home/j/.bun/install/global/node_modules/@mangostudio/cli-linux-x64/mangostudio',
          env: { MANGOSTUDIO_LAUNCHER: 'npm', MANGOSTUDIO_LAUNCHER_PATH: bunPath },
        })
      ).manager
    ).toBe('bun');
    expect(
      detectInstallOrigin(
        probe({
          execPath: '/usr/lib/node_modules/@mangostudio/cli-linux-x64/mangostudio',
          env: {
            MANGOSTUDIO_LAUNCHER: 'npm',
            MANGOSTUDIO_LAUNCHER_PATH: '/usr/lib/node_modules/mangostudio/bin/mangostudio.js',
          },
        })
      ).manager
    ).toBe('npm');
  });

  it('falls back to the executable path for a detached hub that lost the marker', () => {
    expect(
      detectInstallOrigin(
        probe({
          execPath:
            'C:\\Users\\j\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@mangostudio\\cli-win32-x64\\mangostudio.exe',
          platform: 'win32',
          localAppData: 'C:\\Users\\j\\AppData\\Local',
          home: 'C:\\Users\\j',
        })
      ).manager
    ).toBe('pnpm');
    expect(
      detectInstallOrigin(
        probe({ execPath: '/opt/homebrew/Cellar/mangostudio/0.1.1/libexec/mangostudio' })
      ).manager
    ).toBe('homebrew');
    expect(
      detectInstallOrigin(
        probe({
          execPath: 'C:\\Users\\j\\scoop\\apps\\mangostudio\\0.1.1\\mangostudio.exe',
          platform: 'win32',
          localAppData: 'C:\\Users\\j\\AppData\\Local',
          home: 'C:\\Users\\j',
        })
      ).manager
    ).toBe('scoop');
  });

  it('reads a Windows dist root under LOCALAPPDATA', () => {
    const origin = detectInstallOrigin(
      probe({
        platform: 'win32',
        home: 'C:\\Users\\j',
        localAppData: 'C:\\Users\\j\\AppData\\Local',
        execPath: 'C:\\Users\\j\\AppData\\Local\\mangostudio\\0.1.1\\mangostudio.exe',
        readFile: (path) =>
          path === 'C:\\Users\\j\\AppData\\Local\\mangostudio\\install-origin.json'
            ? ORIGIN_RECORD
            : null,
      })
    );
    expect(origin.manager).toBe('self-managed');
    expect(origin.record?.version).toBe('0.1.1');
  });

  it('refuses a bare binary with no signal', () => {
    expect(detectInstallOrigin(probe({ execPath: '/opt/mangostudio' })).manager).toBe('unknown');
  });

  it('puts deployment facts above every marker', () => {
    expect(detectInstallOrigin(probe({ version: 'dev' })).manager).toBe('source');
    expect(
      detectInstallOrigin(probe({ standalone: false, execPath: '/usr/bin/bun' })).manager
    ).toBe('source');
    expect(
      detectInstallOrigin(probe({ container: true, env: { MANGOSTUDIO_LAUNCHER: 'npm' } })).manager
    ).toBe('docker');
  });

  it('carries the build channel', () => {
    expect(detectInstallOrigin(probe({ version: '0.1.1-canary.abc1234' })).channel).toBe('canary');
    expect(versionChannel('0.1.1')).toBe('stable');
  });
});

describe('parseInstallOriginRecord', () => {
  it('keeps the known keys and ignores the rest', () => {
    const record = parseInstallOriginRecord(ORIGIN_RECORD);
    expect(record).toEqual({
      origin: 'installer',
      channel: 'stable',
      version: '0.1.1',
      previousVersion: '0.1.0',
      installedAt: '2026-09-01T00:00:00Z',
      source: 'github-release',
    });
  });

  it('returns null for anything that is not a record', () => {
    expect(parseInstallOriginRecord('not json')).toBeNull();
    expect(
      parseInstallOriginRecord('{"origin":"elsewhere","channel":"stable","version":"1"}')
    ).toBeNull();
    expect(parseInstallOriginRecord('{"origin":"installer","channel":"stable"}')).toBeNull();
  });
});

describe('fitInstalledVia', () => {
  it('truncates every path field to the wire cap, dropping nothing else', () => {
    const overlong = 'x'.repeat(INSTALLED_VIA_PATH_MAX + 10);
    const fitted = fitInstalledVia({
      manager: 'self-managed',
      channel: 'stable',
      executable: overlong,
      distRoot: overlong,
      legacy: true,
      launcherPath: overlong,
    });

    expect(fitted.executable).toHaveLength(INSTALLED_VIA_PATH_MAX);
    expect(fitted.distRoot).toHaveLength(INSTALLED_VIA_PATH_MAX);
    expect(fitted.launcherPath).toHaveLength(INSTALLED_VIA_PATH_MAX);
    expect(fitted.legacy).toBe(true);
    expect(fitted.manager).toBe('self-managed');
  });

  it('omits optional fields that were absent rather than fitting undefined', () => {
    const fitted = fitInstalledVia({ manager: 'unknown', channel: 'stable', executable: '/x' });

    expect(fitted).toEqual({ manager: 'unknown', channel: 'stable', executable: '/x' });
  });
});

describe('npmFamilyFromPath', () => {
  it('classifies the three global stores', () => {
    expect(npmFamilyFromPath('/home/j/.bun/install/global/node_modules/mangostudio/bin/x.js')).toBe(
      'bun'
    );
    expect(
      npmFamilyFromPath('C:\\Users\\j\\AppData\\Local\\pnpm\\global\\5\\node_modules\\x.js')
    ).toBe('pnpm');
    expect(npmFamilyFromPath('/usr/local/lib/node_modules/mangostudio/bin/x.js')).toBe('npm');
  });
});

describe('detectInstallOrigin with a custom install root', () => {
  it('finds the origin record two levels above the executable when MANGOSTUDIO_INSTALL_DIR moved the root', () => {
    const origin = detectInstallOrigin(
      probe({
        execPath: '/opt/mango/dist/0.1.1/mangostudio',
        readFile: (path) => (path === '/opt/mango/dist/install-origin.json' ? ORIGIN_RECORD : null),
      })
    );
    expect(origin.manager).toBe('self-managed');
    expect(origin.distRoot).toBe('/opt/mango/dist');
    expect(origin.legacy).toBeUndefined();
  });

  it('treats the configured install dir as a root even without a record', () => {
    const origin = detectInstallOrigin(
      probe({
        execPath: '/srv/tools/mangostudio/0.1.1/mangostudio',
        env: { MANGOSTUDIO_INSTALL_DIR: '/srv/tools/mangostudio' },
      })
    );
    expect(origin.manager).toBe('self-managed');
    expect(origin.distRoot).toBe('/srv/tools/mangostudio');
    expect(origin.legacy).toBe(true);
  });

  it('does not call an arbitrary versioned directory self-managed without a record', () => {
    expect(detectInstallOrigin(probe({ execPath: '/opt/vendor/1.0/mangostudio' })).manager).toBe(
      'unknown'
    );
  });
});
