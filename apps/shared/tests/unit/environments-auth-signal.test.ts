import { describe, expect, it } from 'bun:test';
import {
  type AuthSignalFs,
  directoryExists,
  probeAuthFile,
  probeConfigKey,
} from '@mangostudio/shared/environments/detection';

class FakeAuthSignalFs implements AuthSignalFs {
  readonly readPaths: string[] = [];

  constructor(
    private readonly files: ReadonlyMap<string, string> = new Map(),
    private readonly directories: ReadonlySet<string> = new Set(),
    private readonly unreadable: ReadonlySet<string> = new Set()
  ) {}

  stat(path: string) {
    if (this.unreadable.has(path)) {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }
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

  it('reports an absent credential file as absent rather than present', () => {
    const fs = new FakeAuthSignalFs();

    expect(probeAuthFile('/home/ada/.codex/auth.json', { unknownWhenMissing: false }, fs)).toEqual({
      authenticated: false,
      authSignal: 'file-absent',
    });
  });

  it('never turns an unreadable path into a sign-in verdict', () => {
    const authPath = '/home/ada/.codex/auth.json';
    const configPath = '/home/ada/.cursor/cli-config.json';
    const fs = new FakeAuthSignalFs(
      new Map(),
      new Set(),
      new Set([authPath, configPath, '/home/ada/.claude'])
    );

    expect(probeAuthFile(authPath, { unknownWhenMissing: false }, fs)).toEqual({
      authenticated: false,
      authSignal: 'unknown',
    });
    expect(probeConfigKey(configPath, 'authInfo', fs)).toEqual({
      authenticated: false,
      authSignal: 'unknown',
    });
    // An unreadable config home is not a missing one; claiming otherwise would
    // tell the user to create a directory that is already there.
    expect(directoryExists('/home/ada/.claude', fs)).toBe(true);
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

  it('reports an absent config as absent rather than as a key it never found', () => {
    // The verdict was always right, but the signal said "config-key-present"
    // for a config file that is not there — a reader looking at the signal to
    // explain the verdict was told the opposite of what happened.
    const directory = '/home/ada/.cursor';
    const fs = new FakeAuthSignalFs(new Map(), new Set([directory]));

    expect(probeConfigKey('/home/ada/.cursor/cli-config.json', 'authInfo', fs)).toEqual({
      authenticated: false,
      authSignal: 'config-key-absent',
    });
    expect(probeConfigKey(directory, 'authInfo', fs)).toEqual({
      authenticated: false,
      authSignal: 'config-key-absent',
    });
    expect(fs.readPaths).toEqual([]);
  });

  it('lets no part of the config it parsed reach the result', () => {
    // The bounded read is permitted; leaking what it read is not. Anything
    // recognizable from the file appearing in the returned object would mean a
    // credential-adjacent value had escaped a presence check.
    const path = '/home/ada/.cursor/cli-config.json';
    const secret = 'sk-live-do-not-leak';
    const fs = new FakeAuthSignalFs(
      new Map([[path, JSON.stringify({ authInfo: { token: secret }, email: 'ada@example.com' })]])
    );

    const result = probeConfigKey(path, 'authInfo', fs);

    expect(result).toEqual({ authenticated: true, authSignal: 'config-key-present' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('ada@example.com');
    expect(Object.keys(result).sort()).toEqual(['authSignal', 'authenticated']);
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
