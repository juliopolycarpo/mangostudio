/**
 * The manifest `@mangostudio/protocol` publishes, derived from the one the
 * workspace uses rather than restated.
 *
 * The workspace manifest's `exports` points at `src/`, like every other
 * workspace here, because nothing in the Turbo graph builds `dist/` before a
 * typecheck or a test lane. The published one has to point at `dist/`, and
 * `publishConfig` cannot carry it: **measured on npm 11.19.0, `npm pack` does
 * not apply `publishConfig` field overrides** — it copies the block into the
 * tarball verbatim and leaves `exports` alone. So the swap happens here, and
 * `pack.ts` packs from a staging directory holding the result.
 *
 * @example
 * publishedManifest(workspaceManifest).exports['.']; // { types: './dist/index.d.ts', … }
 */

export interface ProtocolManifest {
  readonly name: string;
  readonly version: string;
  readonly files?: readonly string[];
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly publishConfig?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** The root manifest's Bun catalogs: the unnamed `catalog` and the `catalogs` by name. */
export interface RootCatalogs {
  readonly catalog?: Readonly<Record<string, string>>;
  readonly catalogs?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** Every section that can carry a `catalog:` reference. */
const CATALOG_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/**
 * Replaces each `catalog:` / `catalog:<name>` specifier with the concrete range the root catalog holds. `npm pack`
 * copies the staged manifest verbatim and npm cannot resolve `catalog:`, so a
 * reference left in place makes the package uninstallable. Every section is
 * resolved, `devDependencies` included, so the tarball carries none.
 *
 * @example
 * resolveCatalogReferences({ dependencies: { typebox: 'catalog:' } }, { catalog: { typebox: '1.4.5' } });
 * // { dependencies: { typebox: '1.4.5' } }
 */
export function resolveCatalogReferences<T extends Record<string, unknown>>(
  manifest: T,
  roots: RootCatalogs
): T {
  const resolved: Record<string, unknown> = { ...manifest };
  for (const section of CATALOG_SECTIONS) {
    const declared = manifest[section];
    if (declared === undefined) continue;
    const next: Record<string, string> = {};
    for (const [name, specifier] of Object.entries(declared as Record<string, string>)) {
      if (!specifier.startsWith('catalog:')) {
        next[name] = specifier;
        continue;
      }
      const catalogName = specifier.slice('catalog:'.length);
      const table =
        catalogName === '' || catalogName === 'default'
          ? roots.catalog
          : roots.catalogs?.[catalogName];
      const version = table?.[name];
      if (version === undefined) {
        throw new Error(
          `${section}.${name} references "${specifier}", which the root package.json catalog does not define; expected a range for ${name}.`
        );
      }
      next[name] = version;
    }
    resolved[section] = next;
  }
  return resolved as T;
}

/** The key under `publishConfig` holding the published `exports` map. */
const PUBLISHED_EXPORTS = 'exports';

/**
 * The published `exports` map a workspace manifest declares.
 *
 * @example
 * publishedExports(manifest); // { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, … }
 */
export function publishedExports(manifest: ProtocolManifest): Record<string, unknown> {
  const map = manifest.publishConfig?.[PUBLISHED_EXPORTS];
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error(
      `${manifest.name} declares no publishConfig.exports; expected the published map pointing at dist/, received ${JSON.stringify(map ?? null)}.`
    );
  }
  return map as Record<string, unknown>;
}

/** The subpaths the published package offers, in declaration order. */
export function publishedSubpaths(manifest: ProtocolManifest): string[] {
  return Object.keys(publishedExports(manifest));
}

/**
 * Every file path an `exports` map names, flattened across condition objects. A
 * string target is the path; an object target is a set of condition → path pairs.
 *
 * @example
 * exportTargets({ '.': { types: './dist/index.d.ts', default: './dist/index.js' } });
 * // ['./dist/index.d.ts', './dist/index.js']
 */
export function exportTargets(map: Readonly<Record<string, unknown>>): string[] {
  const targets: string[] = [];
  for (const value of Object.values(map)) {
    if (typeof value === 'string') {
      targets.push(value);
      continue;
    }
    if (value !== null && typeof value === 'object') {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        if (typeof nested === 'string') targets.push(nested);
      }
    }
  }
  return targets;
}

/** The top-level entry a path sits under, which is what `files` has to list. */
function rootOf(target: string): string {
  return target.replace(/^\.\//, '').split('/')[0] ?? '';
}

/**
 * Names every published export target whose top-level root `files` does not
 * ship. npm accepts an `exports` map pointing at a path the tarball omits, and
 * only an installing consumer ever finds out.
 *
 * @example
 * unshippedTargets({ name: 'x', version: '1', files: ['dist'], publishConfig: { exports: { '.': './schema/a.json' } } });
 * // ['./schema/a.json']
 */
export function unshippedTargets(manifest: ProtocolManifest): string[] {
  // npm always ships the manifest itself, whatever `files` says.
  const shipped = new Set([...(manifest.files ?? []).map(rootOf), 'package.json']);
  return exportTargets(publishedExports(manifest)).filter((target) => !shipped.has(rootOf(target)));
}

/**
 * The manifest to pack: `exports` replaced by the published map,
 * `publishConfig` reduced to the settings npm does honour so the block does not
 * ship a stale second copy of the map, and `scripts` dropped.
 *
 * `scripts` has to go: they are workspace tasks (`build`, `typecheck`,
 * `circular`, `prepack`) that reference `build.ts`, which the tarball does not
 * ship — and npm runs `prepack` again when packing the staged directory, which
 * fails with `Module not found "./build.ts"`. A published SDK has no build
 * scripts.
 *
 * `catalog:` specifiers are resolved against `roots` (the root manifest's
 * catalogs); see `resolveCatalogReferences`.
 *
 * @example
 * publishedManifest(manifest).publishConfig; // { access: 'public' }
 */
export function publishedManifest(
  manifest: ProtocolManifest,
  roots: RootCatalogs = {}
): Record<string, unknown> {
  const published = publishedExports(manifest);
  const unshipped = unshippedTargets(manifest);
  if (unshipped.length > 0) {
    throw new Error(
      `publishConfig.exports points at ${unshipped.join(', ')}, which "files" (${(manifest.files ?? []).join(', ')}) does not ship.`
    );
  }

  const { publishConfig, scripts: _scripts, ...rest } = manifest;
  const honoured: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(publishConfig ?? {})) {
    if (key !== PUBLISHED_EXPORTS) honoured[key] = value;
  }
  return resolveCatalogReferences({ ...rest, exports: published, publishConfig: honoured }, roots);
}
