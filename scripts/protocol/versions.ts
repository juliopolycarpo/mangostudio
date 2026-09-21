/**
 * The one version every Mango Protocol manifest must agree on, and the places
 * it lives. This is the protocol's own release line (`protocol-v*`), which is
 * deliberately independent of the application's root `package.json` version —
 * `scripts/lib/release-version.ts` owns that one, and the two never move
 * together.
 *
 * @example
 * const versions = await readVersions();
 * assertLockstep(versions); // throws naming the manifest that drifted
 */

import { ROOT_DIR } from '../lib/config';

export interface ManifestVersion {
  readonly file: string;
  readonly version: string;
}

/** Repository-relative manifests that carry the protocol package version. */
export const MANIFESTS = {
  protocolPackage: 'packages/protocol/package.json',
  cargoWorkspace: 'Cargo.toml',
  cargoLock: 'Cargo.lock',
} as const;

/**
 * Every `[workspace.dependencies]` path member whose `version` field must
 * track `[workspace.package].version` by hand — Cargo has no "same as the
 * workspace version" shorthand for a dependency requirement the way it does
 * for a member crate's own `version.workspace = true`, and `deny.toml`'s
 * `bans.wildcards = "deny"` requires a path dependency between workspace
 * members to carry an explicit version at all.
 *
 * This is the **protocol** version line (`protocol-v*`). It is a different
 * table from `scripts/lib/release-version.ts`'s `APP_VERSIONED_CRATES`,
 * which tracks the **application** release version (root `package.json`) —
 * two version lines that never move together. A crate whose
 * `[workspace.dependencies]` pin should track this file's version belongs
 * here, not there.
 *
 * Missing an entry here is silent until the next protocol version bump:
 * `readVersions`/`writeVersions` would keep agreeing with each other while
 * the omitted crate's own pin drifted from `[workspace.package].version`,
 * so `check:versions` reports lockstep right up until `cargo build --locked`
 * fails on the stale requirement.
 */
export const WORKSPACE_DEPENDENCY_CRATES = [
  'mango-protocol',
  'mangostudio-runtime-contract',
] as const;

export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The `"version": "…"` line of a package manifest; the field may already hold the target. */
const VERSION_FIELD = /^(\s*"version":\s*)"[^"]+"/m;

/** Escapes regex metacharacters so a crate name can be dropped into a pattern literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reads the version each manifest under `root` declares.
 *
 * @example
 * (await readVersions()).map((entry) => `${entry.file}=${entry.version}`);
 */
export async function readVersions(root = ROOT_DIR): Promise<ManifestVersion[]> {
  const protocolPackage = (await Bun.file(`${root}/${MANIFESTS.protocolPackage}`).json()) as {
    version: string;
  };
  const cargo = await Bun.file(`${root}/${MANIFESTS.cargoWorkspace}`).text();
  const lock = await Bun.file(`${root}/${MANIFESTS.cargoLock}`).text();
  return [
    { file: MANIFESTS.protocolPackage, version: protocolPackage.version },
    { file: MANIFESTS.cargoWorkspace, version: workspaceVersion(cargo) },
    ...WORKSPACE_DEPENDENCY_CRATES.map((crateName) => ({
      // Same file as `cargoWorkspace`, a different section — kept as its own display label so a
      // lockstep failure names which of Cargo.toml's version fields drifted.
      file: `Cargo.toml ([workspace.dependencies] ${crateName})`,
      version: workspaceDependencyVersion(cargo, crateName),
    })),
    ...WORKSPACE_DEPENDENCY_CRATES.map((crateName) => ({
      // The lockfile has one resolved entry per workspace dependency. Keep each one labeled so
      // a stale path-dependency resolution identifies its crate rather than merely Cargo.lock.
      file: `${MANIFESTS.cargoLock} (${crateName})`,
      version: lockedCrateVersion(lock, crateName),
    })),
  ];
}

/**
 * Throws when any manifest disagrees with `expected`, or with the first
 * manifest when no expectation is given.
 *
 * @example
 * assertLockstep(await readVersions(), '0.1.0');
 */
export function assertLockstep(versions: readonly ManifestVersion[], expected?: string): void {
  const reference = expected ?? versions[0]?.version;
  const drifted = versions.filter((entry) => entry.version !== reference);
  if (drifted.length === 0) return;
  const detail = drifted.map((entry) => `${entry.file} has ${entry.version}`).join(', ');
  throw new Error(`Versions are not in lockstep; expected ${reference} everywhere, but ${detail}.`);
}

/**
 * The `version` under `[workspace.package]` of a Cargo.toml text.
 *
 * @example
 * workspaceVersion('[workspace.package]\nversion = "0.1.0"\n'); // '0.1.0'
 */
export function workspaceVersion(cargoToml: string): string {
  const section = cargoToml.split(/^\[workspace\.package\]$/m)[1];
  const match = section?.match(/^version = "([^"]+)"$/m);
  if (!match?.[1]) throw new Error('Cargo.toml has no version under [workspace.package].');
  return match[1];
}

/**
 * The version pinned in `[workspace.dependencies]`'s `crateName` entry — a `path`
 * dependency between workspace members that `deny.toml`'s `bans.wildcards = "deny"` requires
 * to also carry an explicit `version`, kept in lockstep with `[workspace.package].version` by
 * hand rather than structurally, since Cargo has no "same as the workspace version" shorthand
 * for a dependency requirement the way it does for a member crate's own `version.workspace =
 * true`. `crateName` is one of `WORKSPACE_DEPENDENCY_CRATES`.
 *
 * @example
 * workspaceDependencyVersion(
 *   'mango-protocol = { path = "crates/mango-protocol", version = "0.1.0" }\n',
 *   'mango-protocol'
 * ); // '0.1.0'
 */
export function workspaceDependencyVersion(cargoToml: string, crateName: string): string {
  const pattern = new RegExp(
    `${escapeRegExp(crateName)}\\s*=\\s*\\{[^}]*version\\s*=\\s*"([^"]+)"`
  );
  const match = cargoToml.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Cargo.toml has no ${crateName} entry under [workspace.dependencies].`);
  }
  return match[1];
}

/**
 * The version Cargo.lock records for `crateName`.
 *
 * @example
 * lockedCrateVersion(
 *   '[[package]]\nname = "mango-protocol"\nversion = "0.1.0"\n',
 *   'mango-protocol'
 * ); // '0.1.0'
 */
export function lockedCrateVersion(cargoLock: string, crateName: string): string {
  let inNamedPackage = false;
  for (const line of cargoLock.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '[[package]]') {
      inNamedPackage = false;
      continue;
    }
    const name = trimmed.match(/^name\s*=\s*"([^"]+)"/);
    if (name) {
      inNamedPackage = name[1] === crateName;
      continue;
    }
    const version = inNamedPackage ? trimmed.match(/^version\s*=\s*"([^"]+)"/) : null;
    if (version?.[1]) return version[1];
  }
  throw new Error(`Cargo.lock has no entry for ${crateName}.`);
}

/**
 * Rewrites every protocol manifest under `root` to `version`. Cargo.lock is not
 * touched: `cargo update -w` refreshes it afterwards. The root `package.json`
 * is deliberately untouched — it carries the application's version, not this
 * one.
 *
 * @example
 * await writeVersions('0.2.0');
 */
export async function writeVersions(version: string, root = ROOT_DIR): Promise<void> {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(
      `Version "${version}" is not semver; expected MAJOR.MINOR.PATCH with an optional pre-release.`
    );
  }
  const path = `${root}/${MANIFESTS.protocolPackage}`;
  const text = await Bun.file(path).text();
  if (!VERSION_FIELD.test(text)) {
    throw new Error(`${MANIFESTS.protocolPackage} has no version field to rewrite.`);
  }
  const updatedPackage = text.replace(VERSION_FIELD, `$1"${version}"`);

  const cargoPath = `${root}/${MANIFESTS.cargoWorkspace}`;
  const cargo = await Bun.file(cargoPath).text();
  const [head, tail] = cargo.split(/^\[workspace\.package\]$/m);
  if (tail === undefined) throw new Error('Cargo.toml has no [workspace.package] section.');
  if (!/^version = "[^"]+"$/m.test(tail)) {
    throw new Error('Cargo.toml [workspace.package] has no version field to rewrite.');
  }
  const nextTail = tail.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  let updated = `${head}[workspace.package]${nextTail}`;

  for (const crateName of WORKSPACE_DEPENDENCY_CRATES) {
    const dependencyPattern = new RegExp(
      `(${escapeRegExp(crateName)}\\s*=\\s*\\{[^}]*version\\s*=\\s*")[^"]+(")`
    );
    if (!dependencyPattern.test(updated)) {
      throw new Error(`Cargo.toml has no ${crateName} entry under [workspace.dependencies].`);
    }
    updated = updated.replace(dependencyPattern, `$1${version}$2`);
  }

  // Validate and compute every rewrite before touching either manifest. Otherwise a missing later
  // workspace dependency pin would leave the package manifest updated but Cargo.toml unchanged.
  await Bun.write(path, updatedPackage);
  await Bun.write(cargoPath, updated);
}
