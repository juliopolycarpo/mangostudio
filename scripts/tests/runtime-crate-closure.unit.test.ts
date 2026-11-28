import { describe, expect, test } from 'bun:test';

import { type CargoManifest, findRuntimeCrateClosure } from '../lib/runtime-crate-closure';

/** An in-memory checkout: manifests by repository-relative path. */
class FakeManifests {
  constructor(private readonly manifests: Readonly<Record<string, CargoManifest>>) {}

  readonly read = (path: string): CargoManifest => {
    const manifest = this.manifests[path];
    if (!manifest) throw new Error(`FakeManifests: no manifest scripted at ${path}`);
    return manifest;
  };
}

const DECLARED = ['crates/app', 'crates/lib'];

/** `app` depends on `lib` through the workspace table; nothing else is local. */
function baseline(overrides: {
  root?: CargoManifest;
  app?: CargoManifest;
  extra?: Record<string, CargoManifest>;
}): FakeManifests {
  return new FakeManifests({
    'Cargo.toml': {
      workspace: {
        members: ['crates/app', 'crates/lib'],
        dependencies: { lib: { path: 'crates/lib' } },
      },
      ...overrides.root,
    },
    'crates/app/Cargo.toml': {
      package: { name: 'app' },
      dependencies: { lib: { workspace: true } },
      ...overrides.app,
    },
    'crates/lib/Cargo.toml': { package: { name: 'lib' } },
    ...overrides.extra,
  });
}

function closureOf(manifests: FakeManifests) {
  return findRuntimeCrateClosure('crates/app', DECLARED, manifests.read);
}

describe('findRuntimeCrateClosure', () => {
  test('follows a workspace dependency to the declared crate and reports nothing', () => {
    const { reachable, problems } = closureOf(baseline({}));
    expect([...reachable].sort()).toEqual(DECLARED);
    expect(problems).toEqual([]);
  });

  test('a dev-dependency path is not part of the release closure', () => {
    const manifests = baseline({
      app: {
        package: { name: 'app' },
        dependencies: { lib: { workspace: true } },
        // Not a field of CargoManifest on purpose: the walk must never read it.
        ...({ 'dev-dependencies': { foo: { path: '../../vendor/foo' } } } as object),
      },
    });
    expect(closureOf(manifests).problems).toEqual([]);
  });

  test('a path dependency into vendor/ fails, naming the crate and the path', () => {
    const { problems } = closureOf(
      baseline({
        app: {
          package: { name: 'app' },
          dependencies: { lib: { workspace: true }, foo: { path: '../../vendor/foo' } },
        },
      })
    );
    expect(problems).toEqual([
      'expected crates/app to depend only on declared runtime crates | received: foo at path vendor/foo',
    ]);
  });

  test('a vendor path reached through [workspace.dependencies] fails and says so', () => {
    const { problems } = closureOf(
      baseline({
        root: {
          workspace: {
            members: ['crates/app', 'crates/lib'],
            dependencies: { lib: { path: 'crates/lib' }, foo: { path: 'vendor/foo' } },
          },
        },
        app: {
          package: { name: 'app' },
          dependencies: { lib: { workspace: true }, foo: { workspace: true } },
        },
      })
    );
    expect(problems).toEqual([
      'expected crates/app to depend only on declared runtime crates | received: foo at path vendor/foo (via [workspace.dependencies])',
    ]);
  });

  test('target-specific and build dependencies count, and a nested crate is walked', () => {
    const { problems, reachable } = closureOf(
      baseline({
        app: {
          package: { name: 'app' },
          dependencies: { lib: { workspace: true } },
          target: {
            'cfg(windows)': { 'build-dependencies': { foo: { path: '../../vendor/foo' } } },
          },
        },
        extra: {
          'crates/lib/Cargo.toml': {
            package: { name: 'lib' },
            'build-dependencies': { bar: { path: '../../vendor/bar' } },
          },
        },
      })
    );
    expect([...reachable].sort()).toEqual(DECLARED);
    expect([...problems].sort()).toEqual([
      'expected crates/app to depend only on declared runtime crates | received: foo at path vendor/foo',
      'expected crates/lib to depend only on declared runtime crates | received: bar at path vendor/bar',
    ]);
  });

  test('a registry dependency is the lockfile business, even when it shares a member name', () => {
    expect(
      closureOf(
        baseline({
          app: {
            package: { name: 'app' },
            dependencies: { lib: { workspace: true }, serde: '1' },
          },
        })
      ).problems
    ).toEqual([]);
  });

  test('a [patch] or [replace] path outside the declared crates fails, reachable or not', () => {
    const { problems } = closureOf(
      baseline({
        root: {
          workspace: {
            members: ['crates/app', 'crates/lib'],
            dependencies: { lib: { path: 'crates/lib' } },
          },
          patch: { 'crates-io': { serde: { path: 'vendor/serde' }, lib: { path: 'crates/lib' } } },
          replace: { 'tokio:1.0.0': { path: 'vendor/tokio' } },
        },
      })
    );
    expect(problems).toEqual([
      'expected [patch.crates-io] serde to point inside the declared runtime crates | received: path vendor/serde',
      'expected [replace] tokio:1.0.0 to point inside the declared runtime crates | received: path vendor/tokio',
    ]);
  });

  test('a missing manifest is an error naming the path, not a silent skip', () => {
    expect(() =>
      closureOf(
        new FakeManifests({
          'Cargo.toml': { workspace: { members: [] } },
        })
      )
    ).toThrow('FakeManifests: no manifest scripted at crates/app/Cargo.toml');
  });
});
