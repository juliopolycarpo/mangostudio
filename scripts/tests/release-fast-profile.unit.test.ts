import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';
import { cargoRuntimeBuildCommand, cargoRuntimeOutputPath } from '../lib/runtime-build';
import { readText } from './support/read-text';

/**
 * `[profile.release-fast]` builds a runtime about a third larger than the shipping one. Nothing
 * that packages, publishes or stages a runtime may name it or read its `target/release-fast`
 * directory; these tests pin that, because no binary check can tell the two profiles apart.
 */

const PROFILE = 'release-fast';

type Profile = Record<string, unknown> & { package?: Record<string, Record<string, unknown>> };

function rootProfiles(): Record<string, Profile> {
  return (Bun.TOML.parse(readText('Cargo.toml')) as { profile: Record<string, Profile> }).profile;
}

/** Every file under a repo-relative directory, as repo-relative paths. */
function filesUnder(directory: string): string[] {
  return readdirSync(join(ROOT_DIR, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe('[profile.release-fast]', () => {
  test('inherits the shipping profile and changes only link-time optimization and codegen units', () => {
    const { release, [PROFILE]: fast } = rootProfiles();
    expect(
      fast,
      `expected a [profile.${PROFILE}] table in Cargo.toml | received: none`
    ).toBeDefined();
    expect(fast).toEqual({ inherits: 'release', lto: 'thin', 'codegen-units': 16 });
    // The shipping profile is the one the profile above departs from.
    expect(release.lto).toBe('fat');
    expect(release['codegen-units']).toBe(1);
  });

  test('is the only profile besides dev and release that the root manifest defines', () => {
    expect(Object.keys(rootProfiles()).sort()).toEqual(['dev', 'release', PROFILE]);
  });

  test('never reaches a packaging, release or workflow file', () => {
    // Benchmarks and their docs may name the profile; so may tests (this file included).
    const scripts = filesUnder('scripts').filter(
      (file) =>
        !file.startsWith('scripts/bench/') &&
        !file.startsWith('scripts/tests/') &&
        file !== 'scripts/README.md' &&
        !/\.test\.[cm]?[jt]sx?$/.test(file)
    );
    const files = [
      ...filesUnder('.github'),
      ...scripts,
      'Dockerfile',
      'Dockerfile.alpine',
      'crates/mangostudio-launcher/Cargo.toml',
    ];
    const offenders = files.filter((file) => readText(file).includes(PROFILE));
    expect(
      offenders,
      `expected no shipping file to name ${PROFILE} | received: ${offenders.join(', ') || 'none'}`
    ).toEqual([]);
  });

  test('the shipping build command and output path stay on the release profile', () => {
    for (const target of ALL_BINARY_TARGETS) {
      const command = cargoRuntimeBuildCommand(target.arch, { zig: false });
      expect(command).toContain('--release');
      expect(command.join(' ')).not.toContain('--profile');
      expect(cargoRuntimeOutputPath('/repo/target', target)).not.toContain(PROFILE);
    }
  });
});
