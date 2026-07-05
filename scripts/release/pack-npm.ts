#!/usr/bin/env bun
// Assemble the npm distribution from binaries built by `bun run build --binary`.
// Produces dist-npm/<os>-<cpu>/ platform packages (binary + public sidecar) and
// dist-npm/cli/ (the main wrapper with injected optionalDependencies), ready for
// `npm publish`. Run after the binary build; release.yml drives it.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT_DIR } from '../lib/config';
import { removePaths } from '../lib/fs';
import {
  buildMainManifest,
  buildPlatformManifest,
  filterNpmPlatforms,
  type NpmPlatform,
  platformPackageName,
} from '../lib/npm-pack';
import {
  assertNpmDistributionAssets,
  assertPlatformBuildAssets,
  assertPlatformPackageAssets,
} from '../lib/npm-package-validation';
import { resolveReleaseVersion } from '../lib/release-version';
import { error, header, info, success } from '../lib/runner';

const OUT_DIR = join(ROOT_DIR, '.mango', 'out');
const DIST_DIR = join(ROOT_DIR, 'dist-npm');
const CLI_SRC = join(ROOT_DIR, 'packages', 'cli');

const writeManifest = (dir: string, manifest: Record<string, unknown>): void => {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
};

const printHelp = (): never => {
  console.log(`Usage: bun ./scripts/release/pack-npm.ts [--platform <target>]
       bun ./scripts/release/pack-npm.ts --validate [dist-dir] [--platform <target>]

Default:
  Assemble dist-npm/ from .mango/out/ binary build output.

Flags:
  --platform <id>       Limit npm package staging/validation to one target.
  --validate [dist-dir]  Validate staged npm package assets without assembling.
  --help                 Show this help message`);
  process.exit(0);
};

interface CliArgs {
  readonly onlyPlatform?: string;
  readonly validationDistDir?: string;
}

const parseCliArgs = (args: readonly string[]): CliArgs => {
  let onlyPlatform: string | undefined;
  let validationDistDir: string | undefined;
  let validate = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help') printHelp();
    if (arg === '--validate') {
      validate = true;
      const next = args[index + 1];
      if (next && !next.startsWith('--')) {
        validationDistDir = resolve(ROOT_DIR, next);
        index += 1;
      }
      continue;
    }
    if (arg === '--platform') {
      const next = args[index + 1];
      if (!next || next.startsWith('--')) throw new Error('--platform requires a target id');
      onlyPlatform = next;
      index += 1;
      continue;
    }
    if (arg.startsWith('--platform=')) {
      onlyPlatform = arg.slice('--platform='.length);
      if (!onlyPlatform) throw new Error('--platform requires a target id');
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    onlyPlatform,
    validationDistDir: validate ? (validationDistDir ?? resolve(ROOT_DIR, 'dist-npm')) : undefined,
  };
};

// Stage one platform package: manifest + binary (+ optional Cursor sidecar).
const stagePlatform = (platform: NpmPlatform, version: string): NpmPlatform => {
  const sourceDir = join(OUT_DIR, platform.arch);
  const binarySource = join(sourceDir, platform.binary);
  assertPlatformBuildAssets(sourceDir, platform);

  const packageDir = join(DIST_DIR, `${platform.os}-${platform.cpu}`);
  mkdirSync(packageDir, { recursive: true });
  writeManifest(packageDir, buildPlatformManifest(platform, version));
  cpSync(binarySource, join(packageDir, platform.binary));

  // Ship the vendored Cursor SDK sidecar when the binary build produced it, so
  // installs on hosts with Node.js can run the Cursor connector.
  const cursorSidecarSource = join(sourceDir, 'cursor-sidecar');
  if (existsSync(cursorSidecarSource)) {
    cpSync(cursorSidecarSource, join(packageDir, 'cursor-sidecar'), { recursive: true });
  }

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
  info('Staged mangostudio wrapper');
};

const main = async (): Promise<void> => {
  const args = parseCliArgs(process.argv.slice(2));
  const platforms = filterNpmPlatforms(args.onlyPlatform);

  if (args.validationDistDir) {
    header('Validate npm distribution');
    assertNpmDistributionAssets(args.validationDistDir, platforms);
    success(`npm distribution is publishable: ${args.validationDistDir}`);
    return;
  }

  const version = resolveReleaseVersion();
  header(`Pack npm (v${version})`);

  await removePaths(['dist-npm']);
  mkdirSync(DIST_DIR, { recursive: true });

  const staged = platforms.map((platform) => stagePlatform(platform, version));

  stageMainPackage(version, staged);
  assertNpmDistributionAssets(DIST_DIR, staged);
  success(`\nStaged ${staged.length} platform package(s) + the wrapper in dist-npm/.`);
};

try {
  await main();
} catch (caught) {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exit(1);
}
