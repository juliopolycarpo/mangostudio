/**
 * The one version every manifest must agree on, and the places it lives.
 *
 * @example
 * const versions = await readVersions();
 * assertLockstep(versions); // throws naming the manifest that drifted
 */

import { ROOT_DIR } from './lib';

export interface ManifestVersion {
  readonly file: string;
  readonly version: string;
}

/** Repository-relative manifests that carry the package version. */
export const MANIFESTS = {
  rootPackage: 'package.json',
  protocolPackage: 'packages/protocol/package.json',
  cargoWorkspace: 'Cargo.toml',
  cargoLock: 'Cargo.lock',
} as const;

export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The `"version": "…"` line of a package manifest; the field may already hold the target. */
const VERSION_FIELD = /^(\s*"version":\s*)"[^"]+"/m;

/**
 * Reads the version each manifest under `root` declares.
 *
 * @example
 * (await readVersions()).map((entry) => `${entry.file}=${entry.version}`);
 */
export async function readVersions(root = ROOT_DIR): Promise<ManifestVersion[]> {
  const rootPackage = (await Bun.file(`${root}/${MANIFESTS.rootPackage}`).json()) as {
    version: string;
  };
  const protocolPackage = (await Bun.file(`${root}/${MANIFESTS.protocolPackage}`).json()) as {
    version: string;
  };
  const cargo = await Bun.file(`${root}/${MANIFESTS.cargoWorkspace}`).text();
  const lock = await Bun.file(`${root}/${MANIFESTS.cargoLock}`).text();
  return [
    { file: MANIFESTS.rootPackage, version: rootPackage.version },
    { file: MANIFESTS.protocolPackage, version: protocolPackage.version },
    { file: MANIFESTS.cargoWorkspace, version: workspaceVersion(cargo) },
    { file: MANIFESTS.cargoLock, version: lockedCrateVersion(lock) },
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
 * The version Cargo.lock records for the `mango-protocol` crate.
 *
 * @example
 * lockedCrateVersion('[[package]]\nname = "mango-protocol"\nversion = "0.1.0"\n'); // '0.1.0'
 */
export function lockedCrateVersion(cargoLock: string): string {
  const match = cargoLock.match(/name = "mango-protocol"\nversion = "([^"]+)"/);
  if (!match?.[1]) throw new Error('Cargo.lock has no entry for mango-protocol.');
  return match[1];
}

/**
 * Rewrites every manifest under `root` to `version`. Cargo.lock is not touched:
 * `cargo update -w` refreshes it afterwards.
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
  for (const file of [MANIFESTS.rootPackage, MANIFESTS.protocolPackage]) {
    const path = `${root}/${file}`;
    const text = await Bun.file(path).text();
    if (!VERSION_FIELD.test(text)) throw new Error(`${file} has no version field to rewrite.`);
    await Bun.write(path, text.replace(VERSION_FIELD, `$1"${version}"`));
  }
  const cargoPath = `${root}/${MANIFESTS.cargoWorkspace}`;
  const cargo = await Bun.file(cargoPath).text();
  const [head, tail] = cargo.split(/^\[workspace\.package\]$/m);
  if (tail === undefined) throw new Error('Cargo.toml has no [workspace.package] section.');
  const nextTail = tail.replace(/^version = "[^"]+"$/m, `version = "${version}"`);
  await Bun.write(cargoPath, `${head}[workspace.package]${nextTail}`);
}
