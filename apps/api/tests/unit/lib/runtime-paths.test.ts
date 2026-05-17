import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  getDefaultFrontendDir,
  getRuntimeBaseDir,
  isStandaloneExecutable,
} from '../../../src/lib/runtime-paths';

const originalExecPath = process.execPath;
const originalCwd = process.cwd();

function setExecPath(execPath: string): void {
  Object.defineProperty(process, 'execPath', {
    configurable: true,
    value: execPath,
  });
}

describe('runtime paths', () => {
  let tempDir = '';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mango-runtime-paths-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    setExecPath(originalExecPath);
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
});
