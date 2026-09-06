#!/usr/bin/env node
'use strict';

// Locates the prebuilt MangoStudio binary published as a platform-specific
// optional dependency and execs it, forwarding args, stdio, and the exit code.
// npm installs only the optional dependency matching the host os/cpu, so the
// right binary resolves with no install-time download.

const { spawnSync } = require('node:child_process');
const { realpathSync } = require('node:fs');
const { dirname, join } = require('node:path');

// Setting MANGOSTUDIO_WRAPPER_INFO=1 prints how the wrapper resolved the
// platform package (key=value lines, no environment passthrough) and exits
// without spawning the binary. Release verification uses it to assert the
// right platform package was installed, not merely that a binary ran.
const WRAPPER_INFO_ENV = 'MANGOSTUDIO_WRAPPER_INFO';

// Announces this wrapper to the binary it spawns, so detectInstallOrigin can
// tell an npm-family global install apart from a self-managed one sitting at
// the same kind of path — see install-origin.ts. The path names *this* file,
// symlinks resolved, so npmFamilyFromPath can read bun/pnpm/npm off it the
// same way it reads a self-managed dist root off an executable path.
const LAUNCHER_ENV = 'MANGOSTUDIO_LAUNCHER';
const LAUNCHER_PATH_ENV = 'MANGOSTUDIO_LAUNCHER_PATH';

const PLATFORM_PACKAGES = {
  'linux-x64': '@mangostudio/cli-linux-x64',
  'linux-arm64': '@mangostudio/cli-linux-arm64',
  'darwin-x64': '@mangostudio/cli-darwin-x64',
  'darwin-arm64': '@mangostudio/cli-darwin-arm64',
  'win32-x64': '@mangostudio/cli-win32-x64',
  'win32-arm64': '@mangostudio/cli-win32-arm64',
};

function resolveBinary() {
  const key = `${process.platform}-${process.arch}`;
  const packageName = PLATFORM_PACKAGES[key];
  if (!packageName) {
    throw new Error(`MangoStudio does not ship a prebuilt binary for ${key}.`);
  }

  let manifestPath;
  try {
    manifestPath = require.resolve(`${packageName}/package.json`);
  } catch {
    throw new Error(
      `MangoStudio platform package "${packageName}" is not installed. ` +
        'Reinstall with optional dependencies enabled.'
    );
  }

  const binaryName = process.platform === 'win32' ? 'mangostudio.exe' : 'mangostudio';
  return {
    packageName,
    manifestPath,
    binaryPath: join(dirname(manifestPath), binaryName),
  };
}

function printWrapperInfo(resolved) {
  // Read the manifest version lazily here: the normal spawn path never needs
  // it, so parsing package.json belongs only on the diagnostic path.
  process.stdout.write(
    [
      `platform=${process.platform}`,
      `arch=${process.arch}`,
      `package=${resolved.packageName}`,
      `packageVersion=${require(resolved.manifestPath).version}`,
      `binary=${resolved.binaryPath}`,
      `launcherPath=${realpathSync(__filename)}`,
      '',
    ].join('\n')
  );
}

function main() {
  const resolved = resolveBinary();
  if (process.env[WRAPPER_INFO_ENV] === '1') {
    printWrapperInfo(resolved);
    return;
  }
  const result = spawnSync(resolved.binaryPath, process.argv.slice(2), {
    stdio: 'inherit',
    env: {
      ...process.env,
      [LAUNCHER_ENV]: 'npm',
      [LAUNCHER_PATH_ENV]: realpathSync(__filename),
    },
  });
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status === null ? 1 : result.status);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
