import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  describeCursorRuntimeChain,
  evaluateCursorRuntimeAvailability,
} from '../../../../../src/services/providers/cursor/runtime-availability';

const NODE_OK = { available: true, nodePath: '/usr/bin/node', version: 'v22.13.0' };
const SIDECAR_PATH = join('/app', 'cursor-sidecar', 'run-agent.mjs');
const SIDECAR_DIR = join('/app', 'cursor-sidecar');
const NODE_MODULES = join(SIDECAR_DIR, 'node_modules');
const SDK_DIR = join(NODE_MODULES, '@cursor', 'sdk');
const NATIVE_PACKAGE_DIR = join(NODE_MODULES, '@cursor', 'sdk-linux-x64');

function fakeFs(paths: readonly string[], dirs: Record<string, readonly string[]> = {}) {
  const pathSet = new Set(paths);
  return {
    pathExists: (path: string) => pathSet.has(path),
    readDir: (path: string) => dirs[path] ?? [],
  };
}

function completePackagedFs() {
  return fakeFs(
    [
      SIDECAR_PATH,
      NODE_MODULES,
      join(SDK_DIR, 'package.json'),
      join(SDK_DIR, 'dist', 'cjs'),
      join(SDK_DIR, 'dist', 'esm'),
      join(NATIVE_PACKAGE_DIR, 'package.json'),
    ],
    {
      [join(SDK_DIR, 'dist', 'cjs')]: ['642.js', 'index.js'],
      [join(SDK_DIR, 'dist', 'esm')]: ['642.js', 'index.js'],
    }
  );
}

describe('cursor runtime availability', () => {
  it('passes in development when the sidecar script and workspace SDK exist', () => {
    const devSdkPackagePath = join(
      '/repo',
      'apps',
      'api',
      'node_modules',
      '@cursor',
      'sdk',
      'package.json'
    );
    const fs = fakeFs([SIDECAR_PATH, devSdkPackagePath]);

    const status = evaluateCursorRuntimeAvailability(NODE_OK, {
      ...fs,
      devSdkPackagePath,
      sidecarScriptPath: SIDECAR_PATH,
    });

    expect(status.available).toBe(true);
  });

  it('reports a missing SDK package in packaged sidecars', () => {
    const fs = fakeFs([SIDECAR_PATH, NODE_MODULES]);

    const status = evaluateCursorRuntimeAvailability(NODE_OK, {
      ...fs,
      sidecarScriptPath: SIDECAR_PATH,
    });

    expect(status.available).toBe(false);
    expect(status.reasonCode).toBe('cursor.sdk_missing');
  });

  it('reports incomplete SDK chunks in packaged sidecars', () => {
    const fs = fakeFs(
      [
        SIDECAR_PATH,
        NODE_MODULES,
        join(SDK_DIR, 'package.json'),
        join(SDK_DIR, 'dist', 'cjs'),
        join(SDK_DIR, 'dist', 'esm'),
      ],
      {
        [join(SDK_DIR, 'dist', 'cjs')]: ['index.js'],
        [join(SDK_DIR, 'dist', 'esm')]: ['642.js'],
      }
    );

    const status = evaluateCursorRuntimeAvailability(NODE_OK, {
      ...fs,
      sidecarScriptPath: SIDECAR_PATH,
    });

    expect(status.available).toBe(false);
    expect(status.reasonCode).toBe('cursor.sdk_incomplete');
  });

  it('reports a missing native runtime package in packaged sidecars', () => {
    const fs = completePackagedFs();
    const withoutNativePackage = {
      ...fs,
      pathExists: (path: string) =>
        path === join(NATIVE_PACKAGE_DIR, 'package.json') ? false : fs.pathExists(path),
    };

    const status = evaluateCursorRuntimeAvailability(NODE_OK, {
      ...withoutNativePackage,
      platform: 'linux',
      arch: 'x64',
      sidecarScriptPath: SIDECAR_PATH,
    });

    expect(status.available).toBe(false);
    expect(status.reasonCode).toBe('cursor.native_runtime_missing');
    expect(status.reasonParams?.packageName).toBe('@cursor/sdk-linux-x64');
  });

  it('passes packaged sidecars with SDK chunks and the native package', () => {
    const status = evaluateCursorRuntimeAvailability(NODE_OK, {
      ...completePackagedFs(),
      platform: 'linux',
      arch: 'x64',
      sidecarScriptPath: SIDECAR_PATH,
    });

    expect(status.available).toBe(true);
  });
});

describe('describeCursorRuntimeChain', () => {
  it('reports every link independently when Node fails', () => {
    const fs = completePackagedFs();
    const chain = describeCursorRuntimeChain(
      {
        available: false,
        reasonCode: 'cursor.version_insufficient',
        reasonParams: { foundVersion: 'v20.0.0' },
      },
      { ...fs, platform: 'linux', arch: 'x64', sidecarScriptPath: SIDECAR_PATH }
    );

    expect(chain.map((step) => step.link)).toEqual(['node', 'sidecar', 'sdk', 'native']);
    expect(chain[0]?.ok).toBe(false);
    expect(chain[0]?.detail).toContain('22.13');
    expect(chain[1]?.ok).toBe(true);
    expect(chain[3]?.ok).toBe(true);
  });

  it('does not report a false native failure when the SDK resolves from the workspace', () => {
    const devSdkPackagePath = join(
      '/repo',
      'apps',
      'api',
      'node_modules',
      '@cursor',
      'sdk',
      'package.json'
    );
    const fs = fakeFs([SIDECAR_PATH, devSdkPackagePath]);

    const chain = describeCursorRuntimeChain(NODE_OK, {
      ...fs,
      devSdkPackagePath,
      platform: 'linux',
      arch: 'x64',
      sidecarScriptPath: SIDECAR_PATH,
    });

    expect(chain.every((step) => step.ok)).toBe(true);
    expect(chain.at(-1)).toMatchObject({ link: 'native', ok: true });
    expect(chain.at(-1)?.detail).toContain('workspace SDK');
  });

  it('reports unsupported platforms on the native link', () => {
    const chain = describeCursorRuntimeChain(NODE_OK, {
      ...completePackagedFs(),
      platform: 'win32',
      arch: 'arm64',
      sidecarScriptPath: SIDECAR_PATH,
    });

    expect(chain.at(-1)).toMatchObject({
      link: 'native',
      ok: false,
    });
    expect(chain.at(-1)?.detail).toContain('platform unsupported: win32-arm64');
    expect(chain.at(-1)?.detail).toContain('windows-arm64');
  });
});
