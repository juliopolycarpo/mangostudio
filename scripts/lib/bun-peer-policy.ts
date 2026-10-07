import type { PackageManifest } from './dependency-policy';

export interface BunDependencyLock {
  readonly workspaces?: Readonly<Record<string, PackageManifest>>;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly packages: Readonly<Record<string, readonly [string, ...unknown[]]>>;
}

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
const HOST_PEER_KEY = 'bun-plugin-tailwind/bun';
const HOST_PEER_SOURCE = 'bun@file:./scripts/bun-host-peer';

function isHostPeer(key: string, entry: readonly unknown[]): boolean {
  const metadata = entry[1];
  return (
    key === HOST_PEER_KEY &&
    entry[0] === HOST_PEER_SOURCE &&
    entry.length === 2 &&
    metadata !== null &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    Object.keys(metadata).length === 0
  );
}

function describeReferences(
  label: string,
  manifest: PackageManifest,
  key: string,
  packageName: string
): string[] {
  return DEPENDENCY_SECTIONS.flatMap((section) =>
    Object.entries(manifest[section] ?? {})
      .filter(([name]) => name === packageName || key === name || key.endsWith(`/${name}`))
      .map(([name, range]) => `${label} ${section}.${name} (${range})`)
  );
}

function describeImporters(lock: BunDependencyLock, key: string, resolution: string): string {
  const packageName = resolution.slice(0, resolution.indexOf('@', 1));
  const workspaceReferences = Object.entries(lock.workspaces ?? {}).flatMap(([path, manifest]) =>
    describeReferences(path ? `${path}/package.json` : 'package.json', manifest, key, packageName)
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
 * Reject dependency copies of Bun, allowing only the private host-toolchain peer metadata.
 * Usage: assertNoRegistryBunPackages(Bun.JSON5.parse(text) as BunDependencyLock);
 */
export function assertNoRegistryBunPackages(lock: BunDependencyLock): void {
  const violations = Object.entries(lock.packages)
    .filter(
      ([key, entry]) => /^(?:bun|@oven\/bun-[^@]+)@/.test(entry[0]) && !isHostPeer(key, entry)
    )
    .map(
      ([key, entry]) =>
        `${key}: ${entry[0]}, required by ${describeImporters(lock, key, entry[0])}; invalid lock entry ${JSON.stringify(entry)}`
    );
  if (violations.length === 0) return;

  throw new Error(
    `Unexpected Bun runtime dependencies in bun.lock; expected only ${HOST_PEER_KEY}: ${HOST_PEER_SOURCE} with empty metadata, and the externally installed toolchain:\n${violations.join('\n')}`
  );
}
