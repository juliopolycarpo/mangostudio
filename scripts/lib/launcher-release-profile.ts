/**
 * The published `mangostudio` launcher carries its own copy of the workspace `[profile.release]`.
 *
 * `cargo install mangostudio` builds the extracted `.crate` with the package as the root, so the
 * root `Cargo.toml` profile (fat LTO, one codegen unit, stripped) never applies and the user gets
 * Cargo's default release build: about 1.4 MB larger and not stripped. Cargo keeps a member's
 * `[profile.release]` in the packaged manifest and honours it there, while ignoring it inside the
 * workspace. These helpers say how the copy has drifted from the root.
 */

import { isDeepStrictEqual } from 'node:util';

type ProfileTable = Record<string, unknown> & { package?: Record<string, Record<string, unknown>> };
type Manifest = { profile?: { release?: ProfileTable } };
type LockPackage = { name: string; dependencies?: string[] };

/** Names of every package the launcher links, per `Cargo.lock` (an over-approximation across targets). */
export function launcherDependencyNames(lockSource: string, launcher = 'mangostudio'): Set<string> {
  const { package: packages = [] } = Bun.TOML.parse(lockSource) as { package?: LockPackage[] };
  const dependenciesByName = new Map<string, string[]>();
  for (const entry of packages) {
    // A lock dependency is `name` or `name version` when several versions exist.
    const names = (entry.dependencies ?? []).map((dependency) => dependency.split(' ')[0]);
    dependenciesByName.set(entry.name, [...(dependenciesByName.get(entry.name) ?? []), ...names]);
  }
  const reached = new Set<string>();
  const pending = [launcher];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name)) continue;
    reached.add(name);
    pending.push(...(dependenciesByName.get(name) ?? []));
  }
  return reached;
}

function releaseProfile(source: string): ProfileTable {
  return (Bun.TOML.parse(source) as Manifest).profile?.release ?? {};
}

/**
 * Differences between the launcher's `[profile.release]` and what the root manifest would apply
 * to it: every key outside `package`, plus the `package.<name>` override of each root-overridden
 * package the launcher links. An empty list means no drift.
 */
export function launcherReleaseProfileDrift(sources: {
  rootManifest: string;
  launcherManifest: string;
  lockfile: string;
}): string[] {
  const { package: rootPackages = {}, ...rootKeys } = releaseProfile(sources.rootManifest);
  const { package: launcherPackages = {}, ...launcherKeys } = releaseProfile(
    sources.launcherManifest
  );
  const linked = launcherDependencyNames(sources.lockfile);
  const expectedPackages = Object.fromEntries(
    Object.entries(rootPackages).filter(([name]) => linked.has(name))
  );

  const drift: string[] = [];
  if (Object.keys(launcherKeys).length === 0) {
    drift.push('expected a [profile.release] table in the launcher manifest | received: none');
  }
  for (const key of new Set([...Object.keys(rootKeys), ...Object.keys(launcherKeys)])) {
    if (!isDeepStrictEqual(rootKeys[key], launcherKeys[key])) {
      drift.push(
        `[profile.release] ${key}: expected ${JSON.stringify(rootKeys[key])} (workspace) | received: ${JSON.stringify(launcherKeys[key])}`
      );
    }
  }
  for (const name of new Set([
    ...Object.keys(expectedPackages),
    ...Object.keys(launcherPackages),
  ])) {
    if (!isDeepStrictEqual(expectedPackages[name], launcherPackages[name])) {
      drift.push(
        `[profile.release.package.${name}]: expected ${JSON.stringify(expectedPackages[name])} (workspace, for a package the launcher links) | received: ${JSON.stringify(launcherPackages[name])}`
      );
    }
  }
  return drift;
}
