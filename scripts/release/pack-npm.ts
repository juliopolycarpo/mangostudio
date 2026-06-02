#!/usr/bin/env bun
// Assemble the npm distribution from binaries built by `bun run build --binary`.
// Produces dist-npm/<os>-<cpu>/ platform packages (binary + public sidecar) and
// dist-npm/cli/ (the main wrapper with injected optionalDependencies), ready for
// `npm publish`. Run after the binary build; release.yml drives it.

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT_DIR } from '../lib/config';
import { removePaths } from '../lib/fs';
import {
  buildMainManifest,
  buildPlatformManifest,
  NPM_PLATFORMS,
  type NpmPlatform,
  platformPackageName,
} from '../lib/npm-pack';
import {
  assertNpmDistributionAssets,
  assertPlatformBuildAssets,
  assertPlatformPackageAssets,
} from '../lib/npm-package-validation';
import { header, info, success } from '../lib/runner';

const OUT_DIR = join(ROOT_DIR, '.mango', 'out');
const DIST_DIR = join(ROOT_DIR, 'dist-npm');
const CLI_SRC = join(ROOT_DIR, 'packages', 'cli');

const writeManifest = (dir: string, manifest: Record<string, unknown>): void => {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
};

const printHelp = (): never => {
  console.log(`Usage: bun ./scripts/release/pack-npm.ts [--validate [dist-dir]]

Default:
  Assemble dist-npm/ from .mango/out/ binary build output.

Flags:
  --validate [dist-dir]  Validate staged npm package assets without assembling.
  --help                 Show this help message`);
  process.exit(0);
};

const resolveValidationDistDir = (args: readonly string[]): string | undefined => {
  if (args[0] !== '--validate') {
    return undefined;
  }

  if (args.length > 2) {
    throw new Error(`Unexpected validation argument(s): ${args.slice(2).join(' ')}`);
  }

  return resolve(ROOT_DIR, args[1] ?? 'dist-npm');
};

// Stage one platform package: manifest + binary + frontend public/ sidecar.
const stagePlatform = (platform: NpmPlatform, version: string): NpmPlatform => {
  const sourceDir = join(OUT_DIR, platform.arch);
  const binarySource = join(sourceDir, platform.binary);
  assertPlatformBuildAssets(sourceDir, platform);

  const packageDir = join(DIST_DIR, `${platform.os}-${platform.cpu}`);
  mkdirSync(packageDir, { recursive: true });
  writeManifest(packageDir, buildPlatformManifest(platform, version));
  cpSync(binarySource, join(packageDir, platform.binary));

  const publicSource = join(sourceDir, 'public');
  cpSync(publicSource, join(packageDir, 'public'), { recursive: true });
  assertPlatformPackageAssets(packageDir, platform);

  info(`Staged ${platformPackageName(platform)}`);
  return platform;
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
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    printHelp();
  }

  const validationDistDir = resolveValidationDistDir(args);
  if (validationDistDir) {
    header('Validate npm distribution');
    assertNpmDistributionAssets(validationDistDir);
    success(`npm distribution is publishable: ${validationDistDir}`);
    return;
  }

  if (args.length > 0) {
    throw new Error(`Unknown argument(s): ${args.join(' ')}`);
  }

  const version = process.env.VERSION?.replace(/^v/, '') ?? '0.0.0';
  header(`Pack npm (v${version})`);

  await removePaths(['dist-npm']);
  mkdirSync(DIST_DIR, { recursive: true });

  const staged = NPM_PLATFORMS.map((platform) => stagePlatform(platform, version));

  stageMainPackage(version, staged);
  assertNpmDistributionAssets(DIST_DIR, staged);
  success(`\nStaged ${staged.length} platform package(s) + the wrapper in dist-npm/.`);
};

await main();
