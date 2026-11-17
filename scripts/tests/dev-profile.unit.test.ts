import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';

/**
 * The dev profile raises a few dependencies to opt-level 1 so the debug runtime that API tests and CI
 * shards spawn starts in ~66 ms instead of ~190 ms. The comment above the tables in `Cargo.toml` has
 * the measurements; these tests keep the overrides from going stale or reaching the wrong crates.
 */

type PackageOverrides = Record<string, Record<string, unknown>>;

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
  test('every package a dev override names exists in Cargo.lock', () => {
    // A renamed or removed dependency would otherwise leave a dead override behind a Cargo warning.
    const locked = new Set(
      [...readText('Cargo.lock').matchAll(/^name = "([^"]+)"$/gm)].map((match) => match[1])
    );
    const missing = Object.keys(devPackageOverrides()).filter(
      (name) => name !== '*' && !locked.has(name)
    );
    expect(
      missing,
      `expected every [profile.dev.package.<name>] to name a package in Cargo.lock | received missing: ${missing.join(', ') || 'none'}`
    ).toEqual([]);
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
