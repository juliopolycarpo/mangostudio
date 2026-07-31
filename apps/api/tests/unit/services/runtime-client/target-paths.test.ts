import { describe, expect, it } from 'bun:test';
import type { RuntimeCapabilityManifest } from '@mangostudio/shared/runtime-protocol';
import { createTargetPaths } from '../../../../src/services/runtime-client/target-paths';

function manifest(
  pathStyle: RuntimeCapabilityManifest['pathStyle'],
  homeDir: string
): RuntimeCapabilityManifest {
  return {
    platform: pathStyle === 'win32' ? 'win32' : 'linux',
    arch: 'x64',
    pathStyle,
    homeDir,
    shells: [],
    git: { available: false },
    features: {
      tools: true,
      git: true,
      probing: false,
      mcp: false,
      library: false,
      checkpoints: true,
    },
  };
}

const posixPaths = createTargetPaths(manifest('posix', '/home/tester'));
const windowsPaths = createTargetPaths(manifest('win32', 'C:\\Users\\tester'));

describe('createTargetPaths', () => {
  it('reads absoluteness the way the target does, not the hub', () => {
    expect(posixPaths.isAbsolute('/srv/app')).toBe(true);
    expect(posixPaths.isAbsolute('C:\\srv\\app')).toBe(false);
    expect(windowsPaths.isAbsolute('C:\\srv\\app')).toBe(true);
  });

  it('folds . and .. and drops trailing separators', () => {
    expect(posixPaths.canonical('/srv/app/../lib/')).toBe('/srv/lib');
    expect(windowsPaths.canonical('C:\\srv\\app\\..\\lib\\')).toBe('C:\\srv\\lib');
  });

  it('keeps a filesystem root addressable', () => {
    expect(posixPaths.canonical('/')).toBe('/');
    expect(windowsPaths.canonical('C:\\')).toBe('C:\\');
  });

  it('joins relative input with the target separator', () => {
    expect(posixPaths.join('/srv/app', 'src/index.ts')).toBe('/srv/app/src/index.ts');
    expect(windowsPaths.join('C:\\srv\\app', 'src/index.ts')).toBe('C:\\srv\\app\\src\\index.ts');
  });

  it('never falls back to the hub working directory', () => {
    // A relative base would send `node:path`'s own resolve to `process.cwd()`,
    // which names a directory the target need not have.
    expect(posixPaths.join('/srv/app', '../..')).toBe('/');
    expect(windowsPaths.join('C:\\srv\\app', '..\\..\\..')).toBe('C:\\');
  });

  it('treats containment as a whole-segment prefix', () => {
    expect(posixPaths.contains('/srv/app', '/srv/app')).toBe(true);
    expect(posixPaths.contains('/srv/app', '/srv/app/src')).toBe(true);
    expect(posixPaths.contains('/srv/app', '/srv/application')).toBe(false);
    expect(posixPaths.contains('/', '/srv')).toBe(true);
    expect(windowsPaths.contains('C:\\srv\\app', 'C:\\srv\\app\\src')).toBe(true);
    expect(windowsPaths.contains('C:\\', 'C:\\srv')).toBe(true);
  });
});
