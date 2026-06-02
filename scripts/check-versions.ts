#!/usr/bin/env bun
// Fail when the root and workspace package.json versions have drifted. They must
// release in lockstep so the binary, npm packages, and changelog all carry the
// same version. Pass `--expect <version>` (used by the release workflow) to also
// assert the committed version matches the pushed tag.
// Usage: bun run check:versions [--expect <version>]

import { assertVersionsInLockstep, normalizeVersion } from './lib/release-version';
import { fatal, header, log, success } from './lib/runner';

function printHelp(): never {
  console.log(`Usage: bun run check:versions [--expect <version>]

Verifies the root and workspace package.json versions are identical.

Flags:
  --expect <version>  Also require the root version to equal <version> (the tag)
  --help              Show this help message`);
  process.exit(0);
}

function parseExpected(args: readonly string[]): string | undefined {
  const index = args.indexOf('--expect');
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    fatal('`--expect` requires a version argument.');
  }
  return value;
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  printHelp();
}

const expected = parseExpected(args);

header('Check versions');

try {
  const { expected: rootVersion, entries } = assertVersionsInLockstep();

  if (expected && normalizeVersion(expected) !== rootVersion) {
    fatal(
      `Tag version ${normalizeVersion(expected)} does not match package.json version ${rootVersion}.`
    );
  }

  for (const entry of entries) {
    log(`  ${entry.path} → ${entry.version}`);
  }
  success(`\nAll ${entries.length} package.json files agree on v${rootVersion}.`);
} catch (caught) {
  fatal(caught instanceof Error ? caught.message : String(caught));
}
