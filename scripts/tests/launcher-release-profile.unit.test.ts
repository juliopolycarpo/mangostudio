import { describe, expect, test } from 'bun:test';

import {
  launcherDependencyNames,
  launcherReleaseProfileDrift,
} from '../lib/launcher-release-profile';
import { readText } from './support/read-text';

/**
 * `cargo install mangostudio` never reads the workspace `[profile.release]`, so the launcher
 * manifest repeats it. Without the copy the installed binary is 3.5 MB and unstripped instead of
 * 2.2 MB. These tests keep the copy equal to the root; `scripts/release/verify-launcher-package.sh`
 * checks that it survives `cargo package`.
 */

const ROOT_MANIFEST = `
[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
strip = true
panic = "unwind"

[profile.release.package.rustls]
opt-level = "s"
[profile.release.package.jsonschema]
opt-level = "s"
`;

const LOCKFILE = `
[[package]]
name = "mangostudio"
dependencies = ["rustls 0.23.1", "sha2"]

[[package]]
name = "rustls"
version = "0.23.1"

[[package]]
name = "sha2"
version = "0.11.0"

[[package]]
name = "jsonschema"
version = "0.61.0"
`;

const MATCHING_LAUNCHER_MANIFEST = `
[profile.release]
panic = "unwind"
strip = true
codegen-units = 1
lto = "fat"
opt-level = 3

[profile.release.package.rustls]
opt-level = "s"
`;

function drift(overrides: { launcherManifest?: string; rootManifest?: string } = {}) {
  return launcherReleaseProfileDrift({
    rootManifest: overrides.rootManifest ?? ROOT_MANIFEST,
    launcherManifest: overrides.launcherManifest ?? MATCHING_LAUNCHER_MANIFEST,
    lockfile: LOCKFILE,
  });
}

describe('launcherDependencyNames', () => {
  test('follows lock dependencies, with or without a version suffix, and leaves unrelated packages out', () => {
    expect([...launcherDependencyNames(LOCKFILE)].sort()).toEqual([
      'mangostudio',
      'rustls',
      'sha2',
    ]);
  });
});

describe('launcherReleaseProfileDrift', () => {
  test('is empty for a copy with the root keys in any order and only the overrides it links', () => {
    expect(drift()).toEqual([]);
  });

  test('names a lost profile table', () => {
    expect(drift({ launcherManifest: '[package]\nname = "mangostudio"\n' })).toContain(
      'expected a [profile.release] table in the launcher manifest | received: none'
    );
  });

  test('names a key whose value drifted from the root', () => {
    const drifted = MATCHING_LAUNCHER_MANIFEST.replace('lto = "fat"', 'lto = "thin"');
    expect(drift({ launcherManifest: drifted })).toEqual([
      '[profile.release] lto: expected "fat" (workspace) | received: "thin"',
    ]);
  });

  test('names a key the root gained and the launcher lacks', () => {
    const rootGained = ROOT_MANIFEST.replace('panic = "unwind"', 'panic = "unwind"\ndebug = false');
    expect(drift({ rootManifest: rootGained })).toEqual([
      '[profile.release] debug: expected false (workspace) | received: undefined',
    ]);
  });

  test('names a dropped or changed override for a package the launcher links', () => {
    const dropped = MATCHING_LAUNCHER_MANIFEST.replace(
      '[profile.release.package.rustls]\nopt-level = "s"\n',
      ''
    );
    expect(drift({ launcherManifest: dropped })).toEqual([
      '[profile.release.package.rustls]: expected {"opt-level":"s"} (workspace, for a package the launcher links) | received: undefined',
    ]);
    expect(
      drift({
        launcherManifest: dropped.concat('[profile.release.package.rustls]\nopt-level = 3\n'),
      })
    ).toEqual([
      '[profile.release.package.rustls]: expected {"opt-level":"s"} (workspace, for a package the launcher links) | received: {"opt-level":3}',
    ]);
  });

  test('rejects an override for a package the launcher does not link', () => {
    const extra = MATCHING_LAUNCHER_MANIFEST.concat(
      '[profile.release.package.jsonschema]\nopt-level = "s"\n'
    );
    expect(drift({ launcherManifest: extra })).toEqual([
      '[profile.release.package.jsonschema]: expected undefined (workspace, for a package the launcher links) | received: {"opt-level":"s"}',
    ]);
  });
});

describe('the launcher manifest in this repository', () => {
  test('repeats the workspace release profile', () => {
    expect(
      launcherReleaseProfileDrift({
        rootManifest: readText('Cargo.toml'),
        launcherManifest: readText('crates/mangostudio-launcher/Cargo.toml'),
        lockfile: readText('Cargo.lock'),
      })
    ).toEqual([]);
  });

  test('keeps the panic strategy at unwind, the Cargo default the published binary already had', () => {
    const { profile } = Bun.TOML.parse(readText('crates/mangostudio-launcher/Cargo.toml')) as {
      profile: { release: { panic?: string } };
    };
    expect(profile.release.panic).toBe('unwind');
  });
});
