import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
function stageInstall({
  withPlatformPackage = true,
  binaryScript,
}: {
  withPlatformPackage?: boolean;
  binaryScript?: string;
} = {}): string {
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
    const binaryPath = join(packageDir, HOST_BINARY);
    if (binaryScript) {
      writeFileSync(binaryPath, binaryScript);
      chmodSync(binaryPath, 0o755);
    } else {
      writeFileSync(binaryPath, 'not a real binary');
    }
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

  test('reports its own real path as launcherPath', () => {
    const wrapperPath = stageInstall();
    const result = runWrapperInfo(wrapperPath);

    const lines = result.stdout.trim().split('\n');
    // realpath, not the tempdir path stageInstall handed back: on some hosts
    // the tempdir itself is a symlink (macOS /tmp -> /private/tmp), so this
    // checks the wrapper resolved *something*, not that it equals the string
    // this test built the path from.
    expect(
      lines.some((line) => line.startsWith('launcherPath=') && line.endsWith('mangostudio.js'))
    ).toBe(true);
  });
});

describe('npm wrapper launcher markers', () => {
  // Windows lacks a shell to interpret the `#!/bin/sh` fixture below.
  test.skipIf(process.platform === 'win32')(
    'passes MANGOSTUDIO_LAUNCHER and MANGOSTUDIO_LAUNCHER_PATH to the spawned binary',
    () => {
      const wrapperPath = stageInstall({
        binaryScript:
          '#!/bin/sh\nprintf \'%s %s\' "$MANGOSTUDIO_LAUNCHER" "$MANGOSTUDIO_LAUNCHER_PATH"\n',
      });

      const result = spawnSync(process.execPath, [wrapperPath], { encoding: 'utf8' });

      expect(result.status).toBe(0);
      const [launcher, launcherPath] = result.stdout.split(' ');
      expect(launcher).toBe('npm');
      expect(launcherPath).toBe(realpathSync(wrapperPath));
    }
  );
});
