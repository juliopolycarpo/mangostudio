import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';

const WRAPPER_SOURCE = join(ROOT_DIR, 'packages', 'cli', 'bin', 'mangostudio.js');
const HOST_KEY = `${process.platform}-${process.arch}`;
const HOST_PACKAGE = `@mangostudio/cli-${HOST_KEY}`;
const HOST_BINARY = process.platform === 'win32' ? 'mangostudio.exe' : 'mangostudio';

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

// Mirrors a real global install: the wrapper lives in
// node_modules/mangostudio/bin and resolves the platform package through the
// shared ancestor node_modules, exactly as npm lays it out.
function stageInstall({ withPlatformPackage = true } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'mangostudio-cli-wrapper-'));
  tempDirs.push(root);

  const wrapperDir = join(root, 'node_modules', 'mangostudio', 'bin');
  mkdirSync(wrapperDir, { recursive: true });
  copyFileSync(WRAPPER_SOURCE, join(wrapperDir, 'mangostudio.js'));

  if (withPlatformPackage) {
    const packageDir = join(root, 'node_modules', ...HOST_PACKAGE.split('/'));
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({ name: HOST_PACKAGE, version: '9.9.9' })
    );
    writeFileSync(join(packageDir, HOST_BINARY), 'not a real binary');
  }

  return join(wrapperDir, 'mangostudio.js');
}

function runWrapperInfo(wrapperPath: string) {
  return spawnSync(process.execPath, [wrapperPath], {
    encoding: 'utf8',
    env: { ...process.env, MANGOSTUDIO_WRAPPER_INFO: '1' },
  });
}

describe('npm wrapper platform resolution info', () => {
  test('reports the resolved platform package without spawning the binary', () => {
    const result = runWrapperInfo(stageInstall());

    // Exit 0 with the dummy non-executable binary proves nothing was spawned.
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toContain(`platform=${process.platform}`);
    expect(lines).toContain(`arch=${process.arch}`);
    expect(lines).toContain(`package=${HOST_PACKAGE}`);
    expect(lines).toContain('packageVersion=9.9.9');
    expect(lines.some((line) => line.startsWith('binary=') && line.endsWith(HOST_BINARY))).toBe(
      true
    );
  });

  test('fails with the reinstall hint when the platform package is missing', () => {
    const result = runWrapperInfo(stageInstall({ withPlatformPackage: false }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`"${HOST_PACKAGE}" is not installed`);
    expect(result.stderr).toContain('optional dependencies');
  });
});
