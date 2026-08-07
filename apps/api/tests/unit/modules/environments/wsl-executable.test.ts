import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigForTest, resetConfig } from '../../../../src/lib/config';
import {
  resetWslExecutableCache,
  resolveWslExecutable,
} from '../../../../src/modules/environments/infrastructure/wsl-executable';

const ORIGINAL_PLATFORM = process.platform;
const ENV_KEYS = ['ProgramFiles', 'ProgramW6432', 'SystemRoot'] as const;
const originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = {
  ProgramFiles: process.env.ProgramFiles,
  ProgramW6432: process.env.ProgramW6432,
  SystemRoot: process.env.SystemRoot,
};

let dir: string;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/** Creates `<dir>/<segments...>/wsl.exe` and returns its full path. */
function makeWslExe(...segments: string[]): string {
  const target = join(dir, ...segments, 'wsl.exe');
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, '');
  return target;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mango-wsl-executable-'));
  resetWslExecutableCache();
  resetConfig();
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  resetWslExecutableCache();
  resetConfig();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveWslExecutable', () => {
  it('answers a fixed PATH lookup off Windows, no matter what is configured', () => {
    setPlatform('linux');
    loadConfigForTest({
      environments: {
        ltsRefresh: false,
        installsEnabled: false,
        container: false,
        wslExecutable: 'C:\\ignored\\wsl.exe',
      },
    });
    process.env.ProgramFiles = join(dir, 'Program Files');

    expect(resolveWslExecutable()).toEqual({ path: 'wsl.exe', source: 'path' });
  });

  it('takes MANGO_WSL_EXE verbatim, without checking that it exists', () => {
    setPlatform('win32');
    const override = join(dir, 'nowhere', 'wsl.exe');
    loadConfigForTest({
      environments: {
        ltsRefresh: false,
        installsEnabled: false,
        container: false,
        wslExecutable: override,
      },
    });

    expect(resolveWslExecutable()).toEqual({ path: override, source: 'override' });
  });

  it('prefers the Program Files install over the System32 launcher stub', () => {
    setPlatform('win32');
    loadConfigForTest();
    process.env.ProgramFiles = join(dir, 'Program Files');
    process.env.SystemRoot = join(dir, 'Windows');
    const programFilesExe = makeWslExe('Program Files', 'WSL');
    makeWslExe('Windows', 'System32');

    expect(resolveWslExecutable()).toEqual({ path: programFilesExe, source: 'program-files' });
  });

  it('falls back to ProgramW6432 for a 32-bit host process', () => {
    setPlatform('win32');
    loadConfigForTest();
    process.env.ProgramFiles = join(dir, 'Program Files (x86)');
    process.env.ProgramW6432 = join(dir, 'Program Files');
    const redirectedExe = makeWslExe('Program Files', 'WSL');

    expect(resolveWslExecutable()).toEqual({ path: redirectedExe, source: 'program-files' });
  });

  it('falls back to the System32 launcher when Program Files has no install', () => {
    setPlatform('win32');
    loadConfigForTest();
    process.env.ProgramFiles = join(dir, 'Program Files');
    process.env.SystemRoot = join(dir, 'Windows');
    const system32Exe = makeWslExe('Windows', 'System32');

    expect(resolveWslExecutable()).toEqual({ path: system32Exe, source: 'system32' });
  });

  it('falls back to a bare PATH lookup when neither candidate exists', () => {
    setPlatform('win32');
    loadConfigForTest();
    process.env.ProgramFiles = join(dir, 'Program Files');
    process.env.SystemRoot = join(dir, 'Windows');

    expect(resolveWslExecutable()).toEqual({ path: 'wsl.exe', source: 'path' });
  });

  it('memoises the answer for the life of the process', () => {
    setPlatform('win32');
    loadConfigForTest();
    process.env.ProgramFiles = join(dir, 'Program Files');
    process.env.SystemRoot = join(dir, 'Windows');
    const system32Exe = makeWslExe('Windows', 'System32');

    expect(resolveWslExecutable()).toEqual({ path: system32Exe, source: 'system32' });

    // Installing WSL into Program Files after the first resolve must not
    // change the answer: every WSL call site asks this on the hot connect
    // path, and a second lookup per call would undo the round-trip savings.
    makeWslExe('Program Files', 'WSL');
    expect(resolveWslExecutable()).toEqual({ path: system32Exe, source: 'system32' });

    resetWslExecutableCache();
    expect(resolveWslExecutable().source).toBe('program-files');
  });
});
