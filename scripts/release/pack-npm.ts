#!/usr/bin/env bun
// Assemble the npm distribution from binaries built by `bun run build --binary`.
// Produces dist-npm/<os>-<cpu>/ platform packages (binary + public sidecar) and
// dist-npm/cli/ (the main wrapper with injected optionalDependencies), ready for
// `npm publish`. Run after the binary build; release.yml drives it.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../lib/config';
import { removePaths } from '../lib/fs';
import {
  buildMainManifest,
  buildPlatformManifest,
  NPM_PLATFORMS,
  type NpmPlatform,
  platformPackageName,
} from '../lib/npm-pack';
import { header, info, success, warn } from '../lib/runner';

const OUT_DIR = join(ROOT_DIR, '.mango', 'out');
const DIST_DIR = join(ROOT_DIR, 'dist-npm');
const CLI_SRC = join(ROOT_DIR, 'packages', 'cli');

const writeManifest = (dir: string, manifest: Record<string, unknown>): void => {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
};

// Stage one platform package: manifest + binary + frontend public/ sidecar.
// Returns false when the platform's binary was not built (partial release).
const stagePlatform = (platform: NpmPlatform, version: string): boolean => {
  const sourceDir = join(OUT_DIR, platform.arch);
  const binarySource = join(sourceDir, platform.binary);
  if (!existsSync(binarySource)) {
    warn(
      `Skipping ${platformPackageName(platform)} — ${platform.binary} not found in ${sourceDir}`
    );
    return false;
  }

  const packageDir = join(DIST_DIR, `${platform.os}-${platform.cpu}`);
  mkdirSync(packageDir, { recursive: true });
  writeManifest(packageDir, buildPlatformManifest(platform, version));
  cpSync(binarySource, join(packageDir, platform.binary));

  const publicSource = join(sourceDir, 'public');
  if (existsSync(publicSource)) {
    cpSync(publicSource, join(packageDir, 'public'), { recursive: true });
  }
  info(`Staged ${platformPackageName(platform)}`);
  return true;
};

// Stage the main wrapper package: copy bin + README, inject the version and
// optionalDependencies for the platforms that were actually staged.
const stageMainPackage = (version: string, platforms: readonly NpmPlatform[]): void => {
  const packageDir = join(DIST_DIR, 'cli');
  mkdirSync(join(packageDir, 'bin'), { recursive: true });
  cpSync(join(CLI_SRC, 'bin', 'mangostudio.js'), join(packageDir, 'bin', 'mangostudio.js'));
  cpSync(join(CLI_SRC, 'README.md'), join(packageDir, 'README.md'));

  const baseManifest = JSON.parse(readFileSync(join(CLI_SRC, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  writeManifest(packageDir, buildMainManifest(baseManifest, version, platforms));
  info('Staged @mangostudio/cli wrapper');
};

const main = async (): Promise<void> => {
  const version = process.env.VERSION?.replace(/^v/, '') ?? '0.0.0';
  header(`Pack npm (v${version})`);

  await removePaths(['dist-npm']);
  mkdirSync(DIST_DIR, { recursive: true });

  const staged = NPM_PLATFORMS.filter((platform) => stagePlatform(platform, version));
  if (staged.length === 0) {
    throw new Error(
      'No platform binaries found in .mango/out — run `bun run build --binary` first.'
    );
  }

  stageMainPackage(version, staged);
  success(`\nStaged ${staged.length} platform package(s) + the wrapper in dist-npm/.`);
};

await main();
