// The path dependencies a release build of one workspace crate compiles, read
// from the manifests, and every way a path outside the declared crate
// directories can enter it. `scripts/tests/runtime-input-digest-policy.unit.test.ts`
// runs it on the repository, so a runtime dependency that the input digest
// (`runtime-input-digest.ts`) does not hash fails a test instead of shipping
// an unkeyed binary.
//
// Reachability follows `dependencies`, `build-dependencies` and their
// `target.*` forms, through `workspace = true` into the root
// `[workspace.dependencies]`. `dev-dependencies` are skipped: `cargo build -p`
// never builds them, and resolver 3 does not unify their features. A registry
// or git dependency is the lockfile's business. `[patch]` and `[replace]` in
// the root manifest can swap any registry crate for a local path, so a path
// there is checked whether or not anything reachable names the crate.

import { posix } from 'node:path';

/** A parsed `Cargo.toml`, as `Bun.TOML.parse` returns it. */
export interface CargoManifest {
  readonly package?: { readonly name?: string };
  readonly workspace?: {
    readonly members?: readonly string[];
    readonly dependencies?: Readonly<Record<string, DependencySpec>>;
  };
  readonly dependencies?: Readonly<Record<string, DependencySpec>>;
  readonly 'build-dependencies'?: Readonly<Record<string, DependencySpec>>;
  readonly target?: Readonly<
    Record<
      string,
      {
        readonly dependencies?: Readonly<Record<string, DependencySpec>>;
        readonly 'build-dependencies'?: Readonly<Record<string, DependencySpec>>;
      }
    >
  >;
  readonly patch?: Readonly<Record<string, Readonly<Record<string, DependencySpec>>>>;
  readonly replace?: Readonly<Record<string, DependencySpec>>;
}

type DependencySpec =
  string | { readonly path?: string; readonly workspace?: boolean; readonly package?: string };

/** Reads and parses the manifest at a repository-relative path, or throws. */
export type ManifestReader = (path: string) => CargoManifest;

export interface RuntimeCrateClosure {
  /** Repository-relative directories of every crate reachable from the start crate, itself included. */
  readonly reachable: ReadonlySet<string>;
  /** One sentence per path that escapes the declared directories, naming the value. */
  readonly problems: readonly string[];
}

function pathOf(spec: DependencySpec | undefined): string | undefined {
  return typeof spec === 'object' ? spec.path : undefined;
}

/**
 * Walk the release dependency graph of `startDir` and report every path
 * dependency, `[patch]` entry and `[replace]` entry that does not resolve to a
 * directory in `declaredDirs`.
 *
 * @example
 * findRuntimeCrateClosure('crates/app', ['crates/app', 'crates/lib'], readManifest);
 * // → { reachable: Set { 'crates/app', 'crates/lib' }, problems: [] }
 */
export function findRuntimeCrateClosure(
  startDir: string,
  declaredDirs: readonly string[],
  readManifest: ManifestReader
): RuntimeCrateClosure {
  const declared = new Set(declaredDirs);
  const reachable = new Set<string>();
  const problems: string[] = [];
  const root = readManifest('Cargo.toml');
  const inherited = root.workspace?.dependencies ?? {};

  const visit = (dir: string): void => {
    if (reachable.has(dir)) return;
    reachable.add(dir);
    const manifest = readManifest(`${dir}/Cargo.toml`);
    const tables = [
      manifest.dependencies,
      manifest['build-dependencies'],
      ...Object.values(manifest.target ?? {}).flatMap((target) => [
        target.dependencies,
        target['build-dependencies'],
      ]),
    ];
    for (const table of tables) {
      for (const [key, spec] of Object.entries(table ?? {})) {
        const viaWorkspace = typeof spec === 'object' && spec.workspace === true;
        // A workspace path is written relative to the root manifest, a member's own relative to it.
        const path = viaWorkspace ? pathOf(inherited[key]) : pathOf(spec);
        if (path === undefined) continue;
        const target = posix.normalize(posix.join(viaWorkspace ? '' : dir, path));
        if (!declared.has(target)) {
          problems.push(
            `expected ${dir} to depend only on declared runtime crates | received: ${key} at path ${target}${viaWorkspace ? ' (via [workspace.dependencies])' : ''}`
          );
          continue;
        }
        visit(target);
      }
    }
  };
  visit(startDir);

  const swaps: Array<[string, DependencySpec]> = [
    ...Object.entries(root.patch ?? {}).flatMap(([registry, table]) =>
      Object.entries(table).map(([name, spec]): [string, DependencySpec] => [
        `[patch.${registry}] ${name}`,
        spec,
      ])
    ),
    ...Object.entries(root.replace ?? {}).map(([name, spec]): [string, DependencySpec] => [
      `[replace] ${name}`,
      spec,
    ]),
  ];
  for (const [label, spec] of swaps) {
    const path = pathOf(spec);
    if (path === undefined) continue;
    const target = posix.normalize(path);
    if (!declared.has(target)) {
      problems.push(
        `expected ${label} to point inside the declared runtime crates | received: path ${target}`
      );
    }
  }
  return { reachable, problems };
}
