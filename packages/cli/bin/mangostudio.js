#!/usr/bin/env node
'use strict';

// Locates the prebuilt MangoStudio binary published as a platform-specific
// optional dependency and execs it, forwarding args, stdio, and the exit code.
// npm installs only the optional dependency matching the host os/cpu, so the
// right binary resolves with no install-time download.

const { spawnSync } = require('node:child_process');
const { dirname, join } = require('node:path');

const PLATFORM_PACKAGES = {
  'linux-x64': '@mangostudio/cli-linux-x64',
  'linux-arm64': '@mangostudio/cli-linux-arm64',
  'darwin-x64': '@mangostudio/cli-darwin-x64',
  'darwin-arm64': '@mangostudio/cli-darwin-arm64',
  'win32-x64': '@mangostudio/cli-win32-x64',
  'win32-arm64': '@mangostudio/cli-win32-arm64',
};

function resolveBinaryPath() {
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
  return join(dirname(manifestPath), binaryName);
}

function main() {
  const result = spawnSync(resolveBinaryPath(), process.argv.slice(2), { stdio: 'inherit' });
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
