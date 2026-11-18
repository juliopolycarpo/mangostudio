import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ROOT_DIR } from '../../lib/config';
import { collectModuleSpecifiers } from '../../lib/import-specifiers';

export interface RuntimeImportWalkResult {
  readonly files: ReadonlySet<string>;
  readonly externalSpecifiers: ReadonlyMap<string, readonly string[]>;
}

function resolveRelativeModule(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  // TS-style ESM specifiers point at the emitted `.js`; the source is `.ts`.
  const sourceOfEmitted = base.replace(/\.js$/, '');
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${sourceOfEmitted}.ts`,
    `${sourceOfEmitted}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  throw new Error(`Unresolved relative import "${specifier}" from ${fromFile}`);
}

function readWorkspaceAliases(rootDir: string): Record<string, string[]> {
  const configPath = join(rootDir, 'scripts', 'tsconfig.json');
  if (!existsSync(configPath)) return {};
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  return config.compilerOptions?.paths ?? {};
}

function resolveWorkspaceModule(
  rootDir: string,
  specifier: string,
  aliases: Record<string, string[]>
): string | null {
  const targets = aliases[specifier];
  if (!targets || !specifier.startsWith('@mangostudio/')) return null;
  const [scope, name, ...subpath] = specifier.split('/');
  const packageName = `${scope}/${name}`;
  const exportName = subpath.length === 0 ? '.' : `./${subpath.join('/')}`;
  const expected = `Workspace alias "${specifier}" -> ${JSON.stringify(targets)} | expected one file matching ${packageName} export "${exportName}"`;
  if (
    !Array.isArray(targets) ||
    targets.length !== 1 ||
    typeof targets[0] !== 'string' ||
    targets[0].includes('*')
  ) {
    throw new Error(`${expected}; wildcard or fallback targets are not allowed`);
  }

  const target = resolve(rootDir, 'scripts', targets[0]);
  const relativeTarget = relative(rootDir, target);
  if (
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(`${expected}; received a path outside the repository: ${target}`);
  }
  let packageDir = dirname(target);
  while (packageDir !== rootDir && !existsSync(join(packageDir, 'package.json'))) {
    packageDir = dirname(packageDir);
  }
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    name?: string;
    exports?: Record<string, unknown>;
  };
  const exportedTarget = manifest.exports?.[exportName];
  if (manifest.name !== packageName || typeof exportedTarget !== 'string') {
    throw new Error(
      `${expected}; received package ${JSON.stringify(manifest.name)} with export target ${JSON.stringify(exportedTarget)}`
    );
  }
  if (resolve(packageDir, exportedTarget) !== target) {
    throw new Error(`${expected}; received different manifest export target ${exportedTarget}`);
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new Error(`${expected}; received a missing or non-file target: ${target}`);
  }
  return target;
}

/**
 * Walk runtime imports, following exact workspace aliases only when their package
 * exports agree. This keeps no-install smoke checks inspecting the original source.
 *
 * @example walkRuntimeImports('scripts/test-build.ts');
 */
export function walkRuntimeImports(
  entryRelativePath: string,
  rootDir = ROOT_DIR
): RuntimeImportWalkResult {
  const resolvedRoot = resolve(rootDir);
  const entry = resolve(resolvedRoot, entryRelativePath);
  const aliases = readWorkspaceAliases(resolvedRoot);
  const workspaceModules = new Map<string, string | null>();
  const files = new Set<string>();
  const externalSpecifiers = new Map<string, string[]>();

  function recordExternal(specifier: string, fromFile: string): void {
    const relativeFrom = relative(resolvedRoot, fromFile).split(sep).join('/');
    const existing = externalSpecifiers.get(specifier);
    if (existing) {
      if (!existing.includes(relativeFrom)) {
        existing.push(relativeFrom);
      }
      return;
    }
    externalSpecifiers.set(specifier, [relativeFrom]);
  }

  function walk(filePath: string): void {
    if (files.has(filePath)) {
      return;
    }
    files.add(filePath);

    function visitSpecifier(specifier: string): void {
      // Runtime builtins ship inside the executable: `node:*`, `bun` and `bun:*`
      // (`bun:ffi`, `bun:sqlite`), never a package a `--no-install` job lacks.
      if (specifier.startsWith('node:') || specifier === 'bun' || specifier.startsWith('bun:')) {
        return;
      }
      if (specifier.startsWith('.')) {
        walk(resolveRelativeModule(filePath, specifier));
        return;
      }
      // One manifest read per specifier, not one per importing file.
      if (!workspaceModules.has(specifier)) {
        workspaceModules.set(specifier, resolveWorkspaceModule(resolvedRoot, specifier, aliases));
      }
      const workspaceModule = workspaceModules.get(specifier);
      if (workspaceModule) {
        walk(workspaceModule);
        return;
      }
      recordExternal(specifier, filePath);
    }

    // Type-only edges are erased at runtime, so a `--no-install` job never loads them.
    for (const { text, typeOnly } of collectModuleSpecifiers(
      readFileSync(filePath, 'utf8'),
      filePath
    )) {
      if (!typeOnly) visitSpecifier(text);
    }
  }

  walk(entry);
  return { files, externalSpecifiers };
}
