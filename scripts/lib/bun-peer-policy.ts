import { MANIFEST_SECTIONS, manifestLabel, type PackageManifest } from './dependency-policy';

export interface BunDependencyLock {
  readonly workspaces?: Readonly<Record<string, PackageManifest>>;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly packages: Readonly<Record<string, readonly [string, ...unknown[]]>>;
}

function describeReferences(
  label: string,
  manifest: PackageManifest,
  key: string,
  packageName: string
): string[] {
  return MANIFEST_SECTIONS.flatMap((section) =>
    Object.entries(manifest[section] ?? {})
      .filter(([name]) => name === packageName || key === name || key.endsWith(`/${name}`))
      .map(([name, range]) => `${label} ${section}.${name} (${range})`)
  );
}

function describeImporters(lock: BunDependencyLock, key: string, resolution: string): string {
  const packageName = resolution.slice(0, resolution.indexOf('@', 1));
  const workspaceReferences = Object.entries(lock.workspaces ?? {}).flatMap(([path, manifest]) =>
    describeReferences(manifestLabel(path), manifest, key, packageName)
  );
  const packageReferences = Object.values(lock.packages).flatMap((entry) => {
    const metadata = entry.length === 2 ? entry[1] : entry[2];
    const manifest = metadata && typeof metadata === 'object' ? (metadata as PackageManifest) : {};
    return describeReferences(entry[0], manifest, key, packageName);
  });
  const references = [...workspaceReferences, ...packageReferences].sort();
  return references.length > 0 ? references.join(', ') : 'no declaring importer in bun.lock';
}

/**
 * Reject every dependency copy of the externally installed Bun toolchain.
 * Usage: assertNoRegistryBunPackages(Bun.JSON5.parse(text) as BunDependencyLock);
 */
export function assertNoRegistryBunPackages(lock: BunDependencyLock): void {
  const violations = Object.entries(lock.packages)
    .filter(([, entry]) => /^(?:bun|@oven\/bun-[^@]+)@/.test(entry[0]))
    .map(
      ([key, entry]) =>
        `${key}: ${entry[0]}, required by ${describeImporters(lock, key, entry[0])}; invalid lock entry ${JSON.stringify(entry)}`
    );
  if (violations.length === 0) return;

  throw new Error(
    `Unexpected Bun runtime dependencies in bun.lock; expected the externally installed toolchain with no Bun runtime packages:\n${violations.join('\n')}`
  );
}
