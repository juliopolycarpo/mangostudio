import { describe, expect, it } from 'bun:test';
import { icaclsArgv, type OwnerOnlyDeps, restrictToOwner } from '../../../src/services/owner-only';

function deps(overrides: Partial<OwnerOnlyDeps> = {}): OwnerOnlyDeps {
  return {
    platform: 'linux',
    user: 'ada',
    chmod: () => Promise.resolve(),
    exec: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    ...overrides,
  };
}

describe('icaclsArgv', () => {
  // `(M)` includes DELETE; `(R,W)` does not. Every writer publishes by renaming
  // over the old file, so a read/write grant would let the first write through
  // and refuse every rotation after it.
  it('grants modify, so a later rename can replace the file', () => {
    expect(icaclsArgv('C:\\Users\\ada\\credentials.json', 'ada')).toEqual([
      'icacls',
      'C:\\Users\\ada\\credentials.json',
      '/inheritance:r',
      '/grant:r',
      'ada:(M)',
    ]);
  });
});

describe('restrictToOwner', () => {
  it('uses mode bits off Windows', async () => {
    const modes: number[] = [];

    const restricted = await restrictToOwner(
      '/home/ada/credentials.json',
      deps({
        chmod: (_path, mode) => {
          modes.push(mode);
          return Promise.resolve();
        },
      })
    );

    expect(restricted).toBe(true);
    expect(modes).toEqual([0o600]);
  });

  it('reports a chmod that could not grant it', async () => {
    const restricted = await restrictToOwner(
      '/home/ada/credentials.json',
      deps({ chmod: () => Promise.reject(new Error('EPERM')) })
    );

    expect(restricted).toBe(false);
  });

  it('writes an ACL on Windows and never touches the mode', async () => {
    const restricted = await restrictToOwner(
      'C:\\Users\\ada\\credentials.json',
      deps({
        platform: 'win32',
        chmod: () => Promise.reject(new Error('chmod must not be the Windows answer')),
      })
    );

    expect(restricted).toBe(true);
  });

  it('reports a refused or absent icacls rather than throwing', async () => {
    const restricted = await restrictToOwner(
      'C:\\Users\\ada\\credentials.json',
      deps({
        platform: 'win32',
        exec: () => Promise.resolve({ exitCode: 5, stdout: '', stderr: 'Access is denied.' }),
      })
    );

    expect(restricted).toBe(false);
  });
});
