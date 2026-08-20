#!/usr/bin/env bun

import { resolve } from 'node:path';

import { openTarArchive } from '../lib/archive';
import { assertSafeDistributionArchiveEntries } from '../lib/distribution-manifest';
import { error, success } from '../lib/runner';

async function main(): Promise<void> {
  const [bundleArg, destinationArg, ...extra] = process.argv.slice(2);
  if (!bundleArg || !destinationArg || extra.length > 0) {
    throw new Error(
      'Usage: bun ./scripts/release/extract-distribution.ts <bundle.tar[.gz]> <destination>'
    );
  }

  const bundle = resolve(bundleArg);
  const destination = resolve(destinationArg);
  const archive = await openTarArchive(bundle);
  // Judged before anything is written. `entries` covers file entries only —
  // `Bun.Archive` does not report symlinks — but extraction drops a symlink
  // that points outside the destination and strips leading `..` segments, and
  // the manifest SHA-256 check over the extracted tree is the real backstop.
  assertSafeDistributionArchiveEntries(archive.entries);
  await archive.extract(destination);
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
