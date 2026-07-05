#!/usr/bin/env bun
// One-command release preparation: bump every lockstep manifest, regenerate
// CHANGELOG.md through git-cliff, and self-check with the same gate the release
// workflow runs (`check:versions --expect`). Leaves the working tree staged for
// a single `chore(release): v<version>` commit; committing and tagging stay
// manual (docs/reference/releasing.md).
// Usage: bun run release:prepare <version>

import { ROOT_DIR } from '../lib/config';
import { bumpLockstepVersions } from '../lib/prepare-release';
import { isValidSemver, normalizeVersion } from '../lib/release-version';
import { error, header, log, success } from '../lib/runner';

function printHelp(): never {
  console.log(`Usage: bun run release:prepare <version>

Stages a release in the working tree: bumps the root, workspace, and cargo-shim
manifests to <version> in lockstep, regenerates CHANGELOG.md with git-cliff, and
re-runs check:versions --expect <version> as a self-check. Nothing is committed
or tagged.

Example: bun run release:prepare 0.2.0`);
  process.exit(0);
}

function run(args: readonly string[], label: string): void {
  const proc = Bun.spawnSync(['bun', ...args], {
    cwd: ROOT_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (proc.exitCode !== 0) {
    throw new Error(`${label} failed (exit code ${proc.exitCode}).`);
  }
}

function main(): void {
  const input = (process.argv[2] ?? '').trim();
  if (input === '--help') printHelp();
  if (!input || input.startsWith('--')) {
    throw new Error('Usage: bun run release:prepare <version> (e.g. 0.2.0)');
  }
  if (!isValidSemver(input)) {
    throw new Error(`Invalid version "${input}"; expected semver like 0.2.0.`);
  }
  const version = normalizeVersion(input);

  header(`Prepare release v${version}`);
  for (const path of bumpLockstepVersions(version)) {
    log(`  bumped ${path}`);
  }

  run(['./scripts/changelog.ts', '--release', version], 'Changelog regeneration');
  run(['./scripts/check-versions.ts', '--expect', version], 'Release self-check');

  success(`\nRelease v${version} is staged in the working tree. Next:
  git add -A && git commit -s -S -m "chore(release): v${version}"
  git tag -s v${version} -m "v${version}"
  git push origin main v${version}`);
}

try {
  main();
} catch (caught) {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exit(1);
}
