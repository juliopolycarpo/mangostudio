import { describe, expect, it } from 'bun:test';
import {
  type AuthSignalFs,
  directoryExists,
  probeAuthFile,
  probeConfigKey,
} from '../../../../src/modules/environments/domain/auth-signal';

class FakeAuthSignalFs implements AuthSignalFs {
  readonly readPaths: string[] = [];

  constructor(
    private readonly files: ReadonlyMap<string, string> = new Map(),
    private readonly directories: ReadonlySet<string> = new Set()
  ) {}

  stat(path: string) {
    if (this.files.has(path)) {
      return {
        isDirectory: () => false,
        isFile: () => true,
      };
    }
    if (this.directories.has(path)) {
      return {
        isDirectory: () => true,
        isFile: () => false,
      };
    }
    throw Object.assign(new Error('not found'), { code: 'ENOENT' });
  }

  readFile(path: string): string {
    this.readPaths.push(path);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`Unexpected read: ${path}`);
    return value;
  }
}

describe('agent auth signals', () => {
  it('uses stat only for credential files', () => {
    const path = '/home/ada/.codex/auth.json';
    const fs = new FakeAuthSignalFs(new Map([[path, 'must never be read']]));

    expect(probeAuthFile(path, { unknownWhenMissing: false }, fs)).toEqual({
      authenticated: true,
      authSignal: 'file-present',
    });
    expect(fs.readPaths).toEqual([]);
  });

  it('keeps a missing Claude credential file ambiguous because auth may use a keychain', () => {
    const fs = new FakeAuthSignalFs();

    expect(
      probeAuthFile('/home/ada/.claude/.credentials.json', { unknownWhenMissing: true }, fs)
    ).toEqual({
      authenticated: false,
      authSignal: 'unknown',
    });
  });

  it('checks only whether Cursor authInfo is a top-level config key', () => {
    const withAuth = '/home/ada/.cursor/with-auth.json';
    const withoutAuth = '/home/ada/.cursor/without-auth.json';
    const malformed = '/home/ada/.cursor/malformed.json';
    const fs = new FakeAuthSignalFs(
      new Map([
        [withAuth, JSON.stringify({ authInfo: null, unrelated: 'ignored' })],
        [withoutAuth, JSON.stringify({ theme: 'dark' })],
        [malformed, '{'],
      ])
    );

    expect(probeConfigKey(withAuth, 'authInfo', fs)).toEqual({
      authenticated: true,
      authSignal: 'config-key-present',
    });
    expect(probeConfigKey(withoutAuth, 'authInfo', fs)).toEqual({
      authenticated: false,
      authSignal: 'config-key-present',
    });
    expect(probeConfigKey(malformed, 'authInfo', fs)).toEqual({
      authenticated: false,
      authSignal: 'unknown',
    });
  });

  it('distinguishes an existing config directory from a file or missing path', () => {
    const fs = new FakeAuthSignalFs(
      new Map([['/home/ada/file', 'content']]),
      new Set(['/home/ada/.codex'])
    );

    expect(directoryExists('/home/ada/.codex', fs)).toBe(true);
    expect(directoryExists('/home/ada/file', fs)).toBe(false);
    expect(directoryExists('/home/ada/missing', fs)).toBe(false);
  });
});
