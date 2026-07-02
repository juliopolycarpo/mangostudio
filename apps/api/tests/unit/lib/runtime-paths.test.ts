import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfigForTest, resetConfig } from '../../../src/lib/config';
import {
  getCursorSidecarScriptPath,
  getDefaultFrontendDir,
  getRuntimeBaseDir,
  isStandaloneExecutable,
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
    expect(getDefaultFrontendDir()).toBe(join(dirname(executablePath), 'public'));
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
    expect(getDefaultFrontendDir()).toBe(join(installDir, 'public'));
  });

  it('prefers the monorepo frontend dist directory when it exists', () => {
    setExecPath('/usr/bin/bun');
    const frontendDistDir = join(tempDir, 'apps', 'frontend', 'dist');
    mkdirSync(frontendDistDir, { recursive: true });

    expect(getDefaultFrontendDir()).toBe(frontendDistDir);
  });

  it('falls back to a local public directory in development', () => {
    setExecPath('/usr/bin/bun');

    expect(getDefaultFrontendDir()).toBe(join(tempDir, 'public'));
  });

  it('honors a configured Cursor sidecar script override', () => {
    const overridePath = join(tempDir, 'custom-sidecar', 'run-agent.mjs');
    loadConfigForTest({ cursor: { workspaceDir: '', sidecarScriptPath: overridePath } });

    expect(getCursorSidecarScriptPath()).toBe(overridePath);
  });
});
