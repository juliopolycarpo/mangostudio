// Section-aware version stampers for the launcher manifest and workspace lockfile, plus the
// lockfile reader they mirror. The stampers mirror readCargoManifestVersion /
// cargoLockVersion so the canary job can rewrite an ephemeral prerelease
// version into Cargo.toml + Cargo.lock without a TOML dependency, then publish
// with `cargo publish --locked --allow-dirty`. Pure string transforms — IO lives
// in scripts/lib/prepare-release.ts so they stay unit-testable.

const VERSION_LINE = /^(\s*version\s*=\s*")[^"]+(".*)$/;

/** Rewrite the `[package]` version in a Cargo.toml, leaving dependency tables'
 * own `version =` keys untouched. // Usage: setCargoManifestVersion(src, '0.1.0-canary') */
export function setCargoManifestVersion(source: string, version: string): string {
  let inPackageSection = false;
  let replaced = false;
  const lines = source.split('\n').map((line) => {
    const section = line.trim().match(/^\[(.+)\]$/);
    if (section) {
      inPackageSection = section[1] === 'package';
      return line;
    }
    if (inPackageSection && !replaced && VERSION_LINE.test(line)) {
      replaced = true;
      return line.replace(VERSION_LINE, `$1${version}$2`);
    }
    return line;
  });
  if (!replaced) throw new Error('No [package] version found in Cargo.toml');
  return lines.join('\n');
}

/** One crate's version from a Cargo.lock `[[package]]` entry, or undefined when the lockfile
 * does not list it. // Usage: cargoLockVersion(src, 'mangostudio') -> '0.1.0' */
export function cargoLockVersion(source: string, crateName: string): string | undefined {
  let inNamedPackage = false;
  for (const line of source.split('\n')) {
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
  return undefined;
}

/** Rewrite one crate's version in a Cargo.lock `[[package]]` entry.
 * // Usage: setCargoLockVersion(src, 'mangostudio', '0.1.0-canary') */
export function setCargoLockVersion(source: string, crateName: string, version: string): string {
  let inNamedPackage = false;
  let replaced = false;
  const lines = source.split('\n').map((line) => {
    const trimmed = line.trim();
    if (trimmed === '[[package]]') {
      inNamedPackage = false;
      return line;
    }
    const name = trimmed.match(/^name\s*=\s*"([^"]+)"/);
    if (name) {
      inNamedPackage = name[1] === crateName;
      return line;
    }
    if (inNamedPackage && !replaced && VERSION_LINE.test(line)) {
      replaced = true;
      return line.replace(VERSION_LINE, `$1${version}$2`);
    }
    return line;
  });
  if (!replaced) throw new Error(`Cargo.lock does not list ${crateName}`);
  return lines.join('\n');
}
