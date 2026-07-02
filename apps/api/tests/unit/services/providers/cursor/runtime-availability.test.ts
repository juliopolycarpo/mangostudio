import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { evaluateCursorRuntimeAvailability } from '../../../../../src/services/providers/cursor/runtime-availability';

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
