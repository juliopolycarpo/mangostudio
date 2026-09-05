import { describe, expect, it } from 'bun:test';
import {
  type HubExecutableProbe,
  resolveHubExecutable,
} from '../../../../src/modules/machine/domain/hub-executable';

function probe(overrides: Partial<HubExecutableProbe> = {}): HubExecutableProbe {
  return {
    platform: 'linux',
    standalone: true,
    execPath: '/home/j/.mango/dist/0.1.1/mangostudio',
    entryPath: '/repo/apps/api/src/cli.ts',
    cwd: '/repo',
    home: '/home/j',
    // Every pointer exists; no origin record anywhere, as on every install
    // made before the scripts started writing one.
    pathExists: (path) => !path.endsWith('install-origin.json'),
    ...overrides,
  };
}

describe('resolveHubExecutable', () => {
  it('points an installer layout at the current launcher', () => {
    expect(resolveHubExecutable(probe())).toEqual({
      argv: ['/home/j/.mango/dist/current/mangostudio'],
      pointer: 'current',
    });
  });

  it('falls back to the versioned binary with a note when no launcher exists', () => {
    const result = resolveHubExecutable(probe({ pathExists: () => false }));
    expect(result.argv).toEqual(['/home/j/.mango/dist/0.1.1/mangostudio']);
    expect(result.pointer).toBe('versioned');
    expect(result.note).toContain('/home/j/.mango/dist/current/mangostudio');
  });

  it('uses a package-manager binary where it is', () => {
    expect(
      resolveHubExecutable(
        probe({ execPath: '/opt/homebrew/Cellar/mangostudio/0.1.1/bin/mangostudio' })
      )
    ).toEqual({
      argv: ['/opt/homebrew/Cellar/mangostudio/0.1.1/bin/mangostudio'],
      pointer: 'external',
    });
  });

  it('runs a source checkout through bun from the checkout', () => {
    const result = resolveHubExecutable(probe({ standalone: false, execPath: '/usr/bin/bun' }));
    expect(result.argv).toEqual(['/usr/bin/bun', '/repo/apps/api/src/cli.ts']);
    expect(result.workingDirectory).toBe('/repo');
    expect(result.pointer).toBe('source');
  });

  it('uses the .cmd shim on Windows, case-insensitively', () => {
    const windows = probe({
      platform: 'win32',
      execPath: 'C:\\Users\\J\\AppData\\Local\\MangoStudio\\0.1.1\\mangostudio.exe',
      home: 'C:\\Users\\J',
      localAppData: 'C:\\Users\\J\\AppData\\Local',
    });
    expect(resolveHubExecutable(windows)).toEqual({
      argv: ['C:\\Users\\J\\AppData\\Local\\mangostudio\\bin\\mangostudio.cmd'],
      pointer: 'current',
    });
  });

  it('does not mistake a sibling directory for the dist root', () => {
    const result = resolveHubExecutable(probe({ execPath: '/home/j/.mango/dist-old/mangostudio' }));
    expect(result.pointer).toBe('external');
  });
});

describe('resolveHubExecutable with a custom install root', () => {
  it('points at the current launcher two levels above the executable when the root carries an origin record', () => {
    const result = resolveHubExecutable(
      probe({
        execPath: '/opt/mango/dist/0.1.1/mangostudio',
        pathExists: (path) =>
          path === '/opt/mango/dist/install-origin.json' ||
          path === '/opt/mango/dist/current/mangostudio',
      })
    );
    expect(result).toEqual({ argv: ['/opt/mango/dist/current/mangostudio'], pointer: 'current' });
  });
});
