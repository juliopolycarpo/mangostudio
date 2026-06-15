#!/usr/bin/env bun
// Print the canary release identity for the current commit, as GITHUB_OUTPUT
// key=value lines, so canary.yml can drive every publish channel from one source:
//   version=<root>-canary.<sha7>   npm packages and release-asset names
//   cargo_version=<root>-canary     rolling crates.io launcher + GitHub assets
//   sha=<sha7>                      mutable Docker `canary-<sha7>` tag (raw short sha)
// Usage: bun ./scripts/release/canary-version.ts >> "$GITHUB_OUTPUT"

import { canaryCargoVersion, canaryReleaseVersion } from '../lib/release-version';
import { error } from '../lib/runner';

function resolveSha(): string {
  const fromEnv = (process.env.GITHUB_SHA ?? '').trim();
  if (fromEnv) return fromEnv;
  const git = Bun.spawnSync(['git', 'rev-parse', 'HEAD']);
  if (git.exitCode !== 0) {
    throw new Error('Cannot resolve commit sha: set GITHUB_SHA or run inside a git repository.');
  }
  return git.stdout.toString().trim();
}

try {
  const sha = resolveSha();
  const version = canaryReleaseVersion(sha);
  const cargoVersion = canaryCargoVersion();
  const short = sha.trim().toLowerCase().slice(0, 7);
  // Plain stdout (no color) so the lines append cleanly to $GITHUB_OUTPUT.
  process.stdout.write(`version=${version}\ncargo_version=${cargoVersion}\nsha=${short}\n`);
} catch (caught) {
  error(caught instanceof Error ? caught.message : String(caught));
  process.exit(1);
}
