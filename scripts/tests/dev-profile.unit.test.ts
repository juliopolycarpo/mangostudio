import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';

/**
 * The dev profile raises a few dependencies to opt-level 1 so the debug runtime that API tests and CI
 * shards spawn starts in ~66 ms instead of ~190 ms. The comment above the tables in `Cargo.toml` has
 * the measurements; these tests keep the shape that makes them true.
 */

type PackageOverrides = Record<string, Record<string, unknown>>;

const HOT_DEPENDENCIES = [
  'fancy-regex',
  'jsonschema',
  'jsonschema-value',
  'referencing',
  'regex-automata',
  'regex-syntax',
  'serde_json',
];

function devPackageOverrides(): PackageOverrides {
  const manifest = Bun.TOML.parse(readText('Cargo.toml')) as {
    profile: { dev: { package: PackageOverrides } };
  };
  return manifest.profile.dev.package;
}

function workspacePackageNames(): string[] {
  const root = Bun.TOML.parse(readText('Cargo.toml')) as { workspace: { members: string[] } };
  return root.workspace.members.map(
    (member) =>
      (Bun.TOML.parse(readText(`${member}/Cargo.toml`)) as { package: { name: string } }).package
        .name
  );
}

describe('[profile.dev.package] opt-level overrides', () => {
  test('every hot dependency of a runtime spawn builds at opt-level 1', () => {
    const overrides = devPackageOverrides();
    const received = Object.fromEntries(
      HOT_DEPENDENCIES.map((name) => [name, overrides[name]?.['opt-level']])
    );
    expect(received, 'expected opt-level 1 for every hot dependency').toEqual(
      Object.fromEntries(HOT_DEPENDENCIES.map((name) => [name, 1]))
    );
  });

  test('no workspace crate is optimized, so editing one keeps its opt-level 0 rebuild', () => {
    const overrides = devPackageOverrides();
    const optimized = workspacePackageNames().filter(
      (name) => 'opt-level' in (overrides[name] ?? {})
    );
    expect(
      optimized,
      `expected no opt-level override on a workspace crate | received: ${optimized.join(', ') || 'none'}`
    ).toEqual([]);
  });

  test('the `*` glob stays out of opt-level: it would also optimize proc macros and build scripts', () => {
    const received = devPackageOverrides()['*'];
    expect(received, 'expected [profile.dev.package."*"] to hold only debug = false').toEqual({
      debug: false,
    });
  });
});
