#!/usr/bin/env bun

import { resolve } from 'node:path';

import { assertSafeDistributionArchiveEntries } from '../lib/distribution-manifest';
import { captureCommand } from '../lib/exec';
import { error, success } from '../lib/runner';

async function runTar(args: readonly string[]): Promise<string> {
  const result = await captureCommand(['tar', ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`tar ${args[0]} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export function distributionTarArgs(
  operation: 'list' | 'extract',
  bundle: string,
  destination?: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  // Git Bash ships MSYS GNU tar, which cannot open backslash-separated paths.
  const toTarPath = (path: string): string =>
    platform === 'win32' ? path.replaceAll('\\', '/') : path;
  const args = platform === 'win32' ? ['--force-local'] : [];
  if (operation === 'list') return [...args, '-tzf', toTarPath(bundle)];
  if (!destination) throw new Error('Distribution extraction requires a destination.');
  return [...args, '-xzf', toTarPath(bundle), '-C', toTarPath(destination)];
}

async function main(): Promise<void> {
  const [bundleArg, destinationArg, ...extra] = process.argv.slice(2);
  if (!bundleArg || !destinationArg || extra.length > 0) {
    throw new Error(
      'Usage: bun ./scripts/release/extract-distribution.ts <bundle.tar.gz> <destination>'
    );
  }

  const bundle = resolve(bundleArg);
  const destination = resolve(destinationArg);
  const listing = await runTar(distributionTarArgs('list', bundle));
  assertSafeDistributionArchiveEntries(listing.split('\n').filter(Boolean));
  await runTar(distributionTarArgs('extract', bundle, destination));
  success(`Distribution bundle extracted to ${destination}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (caught) {
    error(caught instanceof Error ? caught.message : String(caught));
    process.exit(1);
  }
}
