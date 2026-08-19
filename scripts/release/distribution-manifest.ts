#!/usr/bin/env bun

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bunCompileRuntimeRevision, bunCrossCompileChannel } from '../lib/bun-cross-runtime';
import { ROOT_DIR } from '../lib/config';
import {
  createDistributionManifest,
  DISTRIBUTION_MANIFEST_FILE,
  type DistributionManifestExpectation,
  type DistributionManifestScope,
  readDistributionManifest,
  validateDistributionManifest,
} from '../lib/distribution-manifest';
import { captureCommand } from '../lib/exec';
import { error, header, requiredEnv, success } from '../lib/runner';

interface Args {
  readonly validate: boolean;
  readonly manifestPath: string;
  readonly target?: string;
  readonly scope: DistributionManifestScope;
  readonly expect?: DistributionManifestExpectation;
}

const MANIFEST_SCOPES = ['all', 'checksums', 'assets', 'npm', 'packaged'] as const;
const MANIFEST_EXPECTATIONS = ['built', 'downloaded'] as const;

function isManifestScope(value: string): value is DistributionManifestScope {
  return (MANIFEST_SCOPES as readonly string[]).includes(value);
}

function isManifestExpectation(value: string): value is DistributionManifestExpectation {
  return (MANIFEST_EXPECTATIONS as readonly string[]).includes(value);
}

function parseArgs(args: readonly string[]): Args {
  let validate = false;
  let manifestPath = join(ROOT_DIR, DISTRIBUTION_MANIFEST_FILE);
  let target: string | undefined;
  let scope: DistributionManifestScope = 'all';
  let expect: DistributionManifestExpectation | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--validate') {
      validate = true;
      const next = args[index + 1];
      if (next && !next.startsWith('--')) {
        manifestPath = join(ROOT_DIR, next);
        index += 1;
      }
      continue;
    }
    if (arg === '--target') {
      target = requiredValue(args, ++index, '--target');
      continue;
    }
    if (arg === '--scope') {
      const value = requiredValue(args, ++index, '--scope');
      if (!isManifestScope(value)) {
        throw new Error(`--scope must be one of: ${MANIFEST_SCOPES.join(', ')}`);
      }
      scope = value;
      continue;
    }
    if (arg === '--expect') {
      const value = requiredValue(args, ++index, '--expect');
      if (!isManifestExpectation(value)) {
        throw new Error(`--expect must be one of: ${MANIFEST_EXPECTATIONS.join(', ')}`);
      }
      expect = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (validate && !expect) {
    throw new Error('--expect is required with --validate');
  }
  return { validate, manifestPath, target, scope, expect };
}

function requiredValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

async function isTrackedSourceDirty(): Promise<boolean> {
  const result = await captureCommand(['git', 'status', '--porcelain', '--untracked-files=no'], {
    cwd: ROOT_DIR,
  });
  if (result.exitCode !== 0) throw new Error('Cannot determine whether tracked source is dirty.');
  return result.stdout.trim().length > 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sourceSha = requiredEnv('SOURCE_SHA');
  const packageVersion = requiredEnv('VERSION');
  const channel = requiredEnv('DISTRIBUTION_CHANNEL');

  if (args.validate) {
    header('Validate distribution manifest');
    const manifest = readDistributionManifest(args.manifestPath);
    validateDistributionManifest(manifest, {
      rootDir: ROOT_DIR,
      sourceSha,
      packageVersion,
      channel,
      target: args.target,
      scope: args.scope,
      expect: args.expect,
    });
    success(`Distribution identity and checksums verified: ${args.manifestPath}`);
    return;
  }

  header('Create distribution manifest');
  const manifest = createDistributionManifest({
    rootDir: ROOT_DIR,
    sourceSha,
    dirty: await isTrackedSourceDirty(),
    packageVersion,
    channel,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    // Reads the runtime the build already fetched; falls back to the host when
    // `.bun-version` pins a release, where `--compile` downloads that same build.
    bunCompileRevision:
      (await bunCompileRuntimeRevision(await bunCrossCompileChannel())) ?? Bun.revision,
  });
  writeFileSync(args.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  success(`Distribution manifest written to ${args.manifestPath}`);
}

try {
  await main();
} catch (caught) {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exit(1);
}
