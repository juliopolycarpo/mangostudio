import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfig } from '../../../src/lib/config';
import {
  getRuntimeBaseDir,
  getSourceFrontendDir,
  isStandaloneExecutable,
  resolveRuntimeLaunchCommand,
} from '../../../src/lib/runtime-paths';

const originalExecPath = process.execPath;
const originalCwd = process.cwd();
const symlinkTest = process.platform === 'win32' ? it.skip : it;

function setExecPath(execPath: string): void {
  Object.defineProperty(process, 'execPath', {
    configurable: true,
    value: execPath,
  });
}

describe('runtime paths', () => {
  let tempDir = '';

  beforeEach(() => {
    // Canonicalize: on macOS tmpdir() lives under /var -> /private/var, and
    // getRuntimeBaseDir() realpath-resolves the executable, so the expected
    // paths must already be resolved for the comparisons to hold.
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'mango-runtime-paths-')));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    setExecPath(originalExecPath);
    resetConfig();
    rmSync(tempDir, { force: true, recursive: true });
  });

  it('uses the Bun runtime cwd during development', () => {
    setExecPath('/usr/bin/bun');

    expect(isStandaloneExecutable()).toBe(false);
    expect(getRuntimeBaseDir()).toBe(tempDir);
  });

  it('uses the executable directory in standalone mode', () => {
    const executablePath = join(tempDir, 'dist', 'mangostudio');
    setExecPath(executablePath);

    expect(isStandaloneExecutable()).toBe(true);
    expect(getRuntimeBaseDir()).toBe(dirname(executablePath));
  });

  symlinkTest('resolves standalone executable symlinks before locating sidecars', () => {
    const installDir = join(tempDir, 'dist', '0.1.0');
    const binDir = join(tempDir, 'bin');
    const executablePath = join(installDir, 'mangostudio');
    const symlinkPath = join(binDir, 'mangostudio');
    mkdirSync(installDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(executablePath, 'binary');
    symlinkSync(executablePath, symlinkPath);
    setExecPath(symlinkPath);

    expect(getRuntimeBaseDir()).toBe(installDir);
  });

  it('resolves the checkout frontend dist directory', () => {
    setExecPath('/usr/bin/bun');
    const frontendDistDir = join(tempDir, 'apps', 'frontend', 'dist');
    mkdirSync(frontendDistDir, { recursive: true });

    expect(getSourceFrontendDir()).toBe(frontendDistDir);
  });

  // Unconditional, so an unbuilt checkout names the directory the build will
  // write to. The `<cwd>/public` fallback this replaced pointed the "no
  // frontend found at" warning at a path nothing ever creates.
  it('names the same directory when the frontend has not been built yet', () => {
    setExecPath('/usr/bin/bun');

    expect(getSourceFrontendDir()).toBe(join(tempDir, 'apps', 'frontend', 'dist'));
  });

  describe('resolveRuntimeLaunchCommand', () => {
    const RUNTIME_BINARY_NAME =
      process.platform === 'win32' ? 'mangostudio-runtime.exe' : 'mangostudio-runtime';
    // apps/api/tests/unit/lib -> apps, then the workspace entry the Bun
    // fallback runs. Mirrors the integration test's own RUNTIME_ENTRY.
    const RUNTIME_ENTRY = join(import.meta.dir, '../../../../runtime/src/cli.ts');

    it('prefers MANGOSTUDIO_RUNTIME_BINARY over a configured binaryPath', () => {
      setExecPath('/usr/bin/bun');

      const launch = resolveRuntimeLaunchCommand('/configured/runtime', {
        MANGOSTUDIO_RUNTIME_BINARY: '/env/runtime',
      });

      expect(launch).toEqual({ command: '/env/runtime', args: [], source: 'env' });
    });

    it('falls back to the configured binaryPath when no env override is set', () => {
      setExecPath('/usr/bin/bun');

      const launch = resolveRuntimeLaunchCommand('/configured/runtime', {});

      expect(launch).toEqual({ command: '/configured/runtime', args: [], source: 'config' });
    });

    it('falls back to the sibling binary when neither env nor config name one', () => {
      const executablePath = join(tempDir, 'dist', 'mangostudio');
      setExecPath(executablePath);

      const launch = resolveRuntimeLaunchCommand(undefined, {});

      expect(launch).toEqual({
        command: join(tempDir, 'dist', RUNTIME_BINARY_NAME),
        args: [],
        source: 'sibling',
      });
    });

    it('falls back to the Bun/TS entry when nothing else names a binary', () => {
      setExecPath('/usr/bin/bun');

      const launch = resolveRuntimeLaunchCommand(undefined, {});

      expect(launch).toEqual({
        command: process.execPath,
        args: [RUNTIME_ENTRY],
        source: 'bun-source',
      });
    });
  });
});
