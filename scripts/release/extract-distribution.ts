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

async function main(): Promise<void> {
  const [bundleArg, destinationArg, ...extra] = process.argv.slice(2);
  if (!bundleArg || !destinationArg || extra.length > 0) {
    throw new Error(
      'Usage: bun ./scripts/release/extract-distribution.ts <bundle.tar.gz> <destination>'
    );
  }

  const bundle = resolve(bundleArg);
  const destination = resolve(destinationArg);
  const listing = await runTar(['-tzf', bundle]);
  assertSafeDistributionArchiveEntries(listing.split('\n').filter(Boolean));
  await runTar(['-xzf', bundle, '-C', destination]);
  success(`Distribution bundle extracted to ${destination}`);
}

try {
  await main();
} catch (caught) {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exit(1);
}
