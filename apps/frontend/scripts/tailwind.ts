/** Bun integration around Tailwind's public compiler and source-aware scanner. */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';
import {
  assertDeclaredSources,
  assertTailwindInputsUnchanged,
  createTailwindInputs,
  readSourceInventory,
  type SourcePattern,
  type TailwindInputs,
} from '@mangostudio/shared/frontend-build/host';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

interface TailwindDiagnostics {
  readonly entry: string;
  readonly dependencies: readonly string[];
  readonly sources: readonly SourcePattern[];
  readonly files: readonly string[];
  readonly globs: readonly { base: string; pattern: string }[];
}
export interface TailwindPlugin extends Bun.BunPlugin {
  prepare(paths: string | readonly string[]): Promise<TailwindInputs>;
  verify(metafile?: Bun.BuildMetafile): TailwindInputs;
  readonly diagnostics: readonly TailwindDiagnostics[];
}

function lockedPackageDependency(
  repositoryRoot: string,
  path: string,
  resolutions: ReadonlySet<string>
): boolean {
  const target = realpathSync(path);
  const local = relative(repositoryRoot, target);
  if (
    local === '..' ||
    local.startsWith(`..${sep}`) ||
    isAbsolute(local) ||
    !local.split(sep).includes('node_modules')
  )
    return false;
  for (let current = dirname(target); current !== repositoryRoot; current = dirname(current)) {
    const manifest = join(current, 'package.json');
    if (!existsSync(manifest)) continue;
    const metadata: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    if (metadata === null || typeof metadata !== 'object') return false;
    const { name, version } = metadata as { name?: unknown; version?: unknown };
    if (typeof name === 'string' && typeof version === 'string')
      return resolutions.has(`${name}@${version}`);
  }
  return false;
}

function lockedResolutions(repositoryRoot: string): ReadonlySet<string> {
  const path = join(repositoryRoot, 'bun.lock');
  const lock = Bun.JSON5.parse(readFileSync(path, 'utf8')) as {
    packages?: Record<string, unknown>;
  };
  if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object')
    throw new Error(`${path}: expected locked package resolutions with integrity`);
  return new Set(
    Object.values(lock.packages)
      .filter(
        (entry): entry is [string, string, unknown, string] =>
          Array.isArray(entry) &&
          typeof entry[0] === 'string' &&
          typeof entry[3] === 'string' &&
          /^sha(?:256|512)-/.test(entry[3])
      )
      .map((entry) => entry[0])
  );
}

/** Resolve Bun metafile inputs in the invoking directory, including Windows volumes. @example resolveMetafileInputPath('../../../C:/repo/icon.svg', 'D:/build/app', 'win32'); */
export function resolveMetafileInputPath(
  path: string,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32') return posix.resolve(cwd, path);
  if (win32.isAbsolute(path)) return win32.resolve(cwd, path);
  if (!/(?:^|[\\/])[a-z]:/i.test(path)) return win32.resolve(cwd, path);
  // Bun 1.4.3 encodes cross-volume inputs with POSIX relative paths, including
  // the target drive as a path component. Reverse that exact coordinate frame.
  const base = posix.resolve('/', cwd.replaceAll('\\', '/'));
  const absolute = posix.resolve(base, path);
  if (!/^\/[a-z]:\/[^:]*$/i.test(absolute) || posix.relative(base, absolute) !== path)
    throw new Error(`${path}: expected Bun metafile path with an unambiguous Windows volume`);
  return win32.normalize(absolute.slice(1));
}

/**
 * Create one compiler/scanner lifetime per Bun build, rooted at the workspace.
 * @example plugins: [createTailwindPlugin({ projectRoot: import.meta.dir })]
 */
export function createTailwindPlugin({
  projectRoot,
}: {
  readonly projectRoot: string;
}): TailwindPlugin {
  const inventory = readSourceInventory(projectRoot);
  const diagnostics: TailwindDiagnostics[] = [];
  let inputs: TailwindInputs | undefined;
  const discoveries = new Map<string, string>();

  function requireDeclaredDependencies(dependencies: Iterable<string>): void {
    let resolutions: ReadonlySet<string> | undefined;
    for (const dependency of dependencies) {
      try {
        assertDeclaredSources(inventory, [
          { base: dirname(dependency), pattern: basename(dependency), negated: false },
        ]);
      } catch (error) {
        resolutions ??= lockedResolutions(inventory.repositoryRoot);
        if (!lockedPackageDependency(inventory.repositoryRoot, dependency, resolutions))
          throw new Error(
            `${dependency}: expected stylesheet dependency declared by tailwind-inputs.json or an installed registry package in bun.lock`,
            { cause: error }
          );
      }
    }
  }

  async function discover(path: string) {
    const dependencies = new Set([path]);
    let compiler: Awaited<ReturnType<typeof compile>>;
    try {
      compiler = await compile(await readFile(path, 'utf8'), {
        base: dirname(path),
        from: path,
        shouldRewriteUrls: true,
        onDependency(dependency) {
          dependencies.add(resolve(dependency));
        },
      });
    } catch (error) {
      throw new Error(`${path}: expected resolvable Tailwind stylesheet; ${String(error)}`, {
        cause: error,
      });
    }
    const automatic =
      compiler.root === 'none'
        ? []
        : compiler.root === null
          ? inventory.defaultSources
          : [{ ...compiler.root, negated: false }];
    const sources = compiler.features ? [...automatic, ...compiler.sources] : [];
    assertDeclaredSources(inventory, sources);
    requireDeclaredDependencies(dependencies);
    dependencies.add(join(inventory.repositoryRoot, 'bun.lock'));
    const paths = [...dependencies].sort();
    return { compiler, sources, dependencies: paths, identity: JSON.stringify([sources, paths]) };
  }
  async function prepare(paths: string | readonly string[]): Promise<TailwindInputs> {
    if (inputs)
      throw new Error(`${projectRoot}: expected one Tailwind preparation per Bun.build()`);
    const sources: SourcePattern[] = [];
    const dependencies = new Set<string>();
    for (const path of typeof paths === 'string' ? [paths] : paths) {
      const result = await discover(path);
      discoveries.set(path, result.identity);
      sources.push(...result.sources);
      for (const dependency of result.dependencies) dependencies.add(dependency);
    }
    inputs = createTailwindInputs(inventory, sources, [...dependencies]);
    return inputs;
  }
  function verify(metafile?: Bun.BuildMetafile): TailwindInputs {
    if (!inputs)
      throw new Error(`${projectRoot}: expected Tailwind preparation before publication`);
    if (metafile) {
      const assets = Object.values(metafile.inputs).flatMap((input) =>
        input.format === 'css'
          ? input.imports
              .filter((dependency) => dependency.kind === 'url-token' && !dependency.external)
              .map((dependency) => resolveMetafileInputPath(dependency.path))
          : []
      );
      // Bun reports graph paths relative to its invocation directory. Scanning still uses projectRoot.
      requireDeclaredDependencies(assets);
    }
    assertTailwindInputsUnchanged(inventory.repositoryRoot, inputs);
    return inputs;
  }
  return {
    name: 'mangostudio-tailwind',
    diagnostics,
    prepare,
    verify,
    setup(build) {
      build.onLoad({ filter: /\.css$/, namespace: 'file' }, async ({ path }) => {
        let result = await discover(path);
        // Plain CSS, including eager xterm styles, stays on Bun's normal asset path.
        if (!result.compiler.features) return undefined;
        if (!inputs) {
          await prepare(path);
          result = await discover(path);
        }
        if (!discoveries.has(path) || result.identity !== discoveries.get(path))
          throw new Error(
            `${path}: expected unchanged Tailwind dependencies and declared sources from discovery`
          );
        verify();
        const scanner = new Scanner({ sources: result.sources });
        const contents = result.compiler.build(scanner.scan());
        diagnostics.push({
          entry: path,
          dependencies: result.dependencies,
          sources: result.sources,
          files: scanner.files,
          globs: scanner.globs,
        });
        return { contents, loader: 'css' };
      });
    },
  };
}
