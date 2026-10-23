/** Private, portable input stamps shared by the frontend builder and dev host. */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface InputPath {
  readonly base: 'repository' | 'absolute';
  readonly path: string;
}
export interface SourcePattern {
  readonly base: string;
  readonly pattern: string;
  readonly negated: boolean;
}
export interface InputRoot {
  readonly path: InputPath;
  readonly kind: 'directory' | 'file';
}
export interface InputControl {
  readonly path: InputPath;
  readonly kind: 'file' | 'repository-marker';
}
export interface TailwindInputs {
  readonly version: 1;
  readonly sources: readonly SourcePattern[];
  readonly roots: readonly InputRoot[];
  readonly files: readonly InputPath[];
  readonly controls: readonly InputControl[];
  readonly digest: string;
  readonly reuse: 'checked' | 'always-build';
}
export interface SourceInventory {
  readonly repositoryRoot: string;
  readonly projectRoot: string;
  readonly defaultSources: readonly SourcePattern[];
  readonly roots: readonly InputRoot[];
}
const SCOPE = 'declared source inside this repository without a nested repository';
const HELPERS = ['tailwind-inputs.json', 'scripts/routes.ts', 'scripts/tailwind.ts'];
const posix = (path: string): string => path.split(sep).join('/');
const sorted = <T>(items: readonly T[]): T[] =>
  [...new Map(items.map((item) => [JSON.stringify(item), item])).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, item]) => item);
const inside = (root: string, path: string): boolean =>
  path === root ||
  (!relative(root, path).startsWith(`..${sep}`) &&
    relative(root, path) !== '..' &&
    !isAbsolute(relative(root, path)));

function fail(path: string, expected: string): never {
  throw new Error(`${path}: expected ${expected}`);
}
function kind(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return undefined;
    throw error;
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function inputPath(repositoryRoot: string, path: string): InputPath {
  return inside(repositoryRoot, path)
    ? { base: 'repository', path: posix(relative(repositoryRoot, path)) }
    : { base: 'absolute', path };
}
function absolute(repositoryRoot: string, path: InputPath): string {
  return path.base === 'repository' ? resolve(repositoryRoot, path.path) : path.path;
}
function canonical(repositoryRoot: string, path: string): string {
  if (!inside(repositoryRoot, path)) fail(path, SCOPE);
  const info = kind(path);
  if (!info) {
    if (path !== repositoryRoot) canonical(repositoryRoot, dirname(path));
    return path;
  }
  let target: string;
  try {
    target = realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      fail(path, 'source symlink without a cycle');
    throw error;
  }
  if (!inside(repositoryRoot, target)) fail(path, SCOPE);
  return target;
}
function checkAncestors(repositoryRoot: string, path: string): void {
  for (const candidate of new Set([path, canonical(repositoryRoot, path)])) {
    const start = kind(candidate)?.isFile() ? dirname(candidate) : candidate;
    for (let current = start; current !== repositoryRoot; current = dirname(current)) {
      if (!inside(repositoryRoot, current)) fail(path, SCOPE);
      if (kind(join(current, '.git'))) fail(join(current, '.git'), SCOPE);
    }
  }
}
function sourceRoot(source: SourcePattern): string {
  const components = source.pattern.split(/[\\/]/);
  const firstGlob = components.findIndex((component) => /[*!?{[]/.test(component));
  const prefix = firstGlob < 0 ? source.pattern : components.slice(0, firstGlob).join('/');
  return resolve(source.base, prefix || '.');
}
function parsePattern(value: unknown, projectRoot: string): SourcePattern {
  if (
    !object(value) ||
    typeof value.base !== 'string' ||
    isAbsolute(value.base) ||
    typeof value.pattern !== 'string' ||
    !value.pattern ||
    isAbsolute(value.pattern) ||
    typeof value.negated !== 'boolean'
  )
    fail(
      JSON.stringify(value),
      'source { base: relative path, pattern: relative glob, negated: boolean }'
    );
  return { base: resolve(projectRoot, value.base), pattern: value.pattern, negated: value.negated };
}

/** Read the declared source boundary, never the invoking shell's cwd. @example readSourceInventory('/repo/apps/frontend'); */
export function readSourceInventory(
  projectRoot: string,
  repositoryRoot = resolve(projectRoot, '../..')
): SourceInventory {
  projectRoot = realpathSync(projectRoot);
  repositoryRoot = realpathSync(repositoryRoot);
  const configPath = join(projectRoot, 'tailwind-inputs.json');
  const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
  if (
    !object(config) ||
    config.version !== 1 ||
    !Array.isArray(config.defaultSources) ||
    !Array.isArray(config.additionalRoots)
  )
    fail(configPath, 'version 1 with defaultSources and additionalRoots arrays');
  const defaultSources = config.defaultSources.map((value) => parsePattern(value, projectRoot));
  const roots: InputRoot[] = defaultSources.map((source) => {
    const path = sourceRoot(source);
    canonical(repositoryRoot, path);
    const wildcard = /[*!?{[]/.test(source.pattern);
    return { path: inputPath(repositoryRoot, path), kind: wildcard ? 'directory' : 'file' };
  });
  for (const value of config.additionalRoots) {
    if (
      !object(value) ||
      typeof value.path !== 'string' ||
      isAbsolute(value.path) ||
      (value.kind !== 'file' && value.kind !== 'directory')
    )
      fail(
        JSON.stringify(value),
        'additional root { path: relative path, kind: directory | file }'
      );
    const path = resolve(projectRoot, value.path);
    canonical(repositoryRoot, path);
    roots.push({ path: inputPath(repositoryRoot, path), kind: value.kind });
  }
  for (const root of roots) {
    const path = absolute(repositoryRoot, root.path);
    if (path === repositoryRoot) fail(path, 'source root narrower than the repository');
    checkAncestors(repositoryRoot, path);
  }
  return { repositoryRoot, projectRoot, defaultSources, roots: sorted(roots) };
}

/** Reject compiler sources outside the explicit inventory. @example assertDeclaredSources(inventory, compiler.sources); */
export function assertDeclaredSources(
  inventory: SourceInventory,
  sources: readonly SourcePattern[]
): void {
  for (const source of sources) {
    const path = sourceRoot(source);
    canonical(inventory.repositoryRoot, path);
    checkAncestors(inventory.repositoryRoot, path);
    const declared = inventory.roots.some((root) =>
      root.kind === 'directory'
        ? inside(absolute(inventory.repositoryRoot, root.path), path)
        : absolute(inventory.repositoryRoot, root.path) === path
    );
    if (!declared)
      fail(path, 'source declared by tailwind-inputs.json defaultSources or additionalRoots');
  }
}

function controlPaths(
  inventory: Pick<SourceInventory, 'repositoryRoot' | 'roots'>
): InputControl[] {
  const { repositoryRoot } = inventory;
  const marker = kind(join(repositoryRoot, '.git'));
  const controls: InputControl[] = [
    { path: inputPath(repositoryRoot, join(repositoryRoot, '.git')), kind: 'repository-marker' },
  ];
  if (marker?.isDirectory())
    controls.push({
      path: inputPath(repositoryRoot, join(repositoryRoot, '.git/info/exclude')),
      kind: 'file',
    });
  for (const root of inventory.roots) {
    let current =
      root.kind === 'directory'
        ? absolute(repositoryRoot, root.path)
        : dirname(absolute(repositoryRoot, root.path));
    while (true) {
      controls.push({ path: inputPath(repositoryRoot, join(current, '.ignore')), kind: 'file' });
      if (!marker || inside(repositoryRoot, current))
        controls.push({
          path: inputPath(repositoryRoot, join(current, '.gitignore')),
          kind: 'file',
        });
      if (dirname(current) === current) break;
      current = dirname(current);
    }
  }
  return sorted(controls);
}
function snapshot(repositoryRoot: string, manifest: Omit<TailwindInputs, 'digest'>): string {
  const records: unknown[] = [];
  const visit = (
    path: string,
    optional: boolean,
    ancestors: ReadonlySet<string> = new Set()
  ): void => {
    const info = kind(path);
    const name = inputPath(repositoryRoot, path);
    if (!info) {
      if (!optional) fail(path, 'required build input');
      records.push([name, 'missing']);
      return;
    }
    const target = canonical(repositoryRoot, path);
    if (target !== path || info.isSymbolicLink())
      records.push([name, 'symlink', inputPath(repositoryRoot, target)]);
    if (ancestors.has(target)) fail(path, 'source symlink without a cycle');
    const actual = info.isSymbolicLink() ? lstatSync(target) : info;
    if (actual.isDirectory()) {
      if (path !== repositoryRoot && kind(join(target, '.git'))) fail(join(path, '.git'), SCOPE);
      records.push([name, 'directory']);
      const next = new Set(ancestors).add(target);
      for (const entry of readdirSync(target).sort()) visit(join(path, entry), false, next);
      return;
    }
    if (!actual.isFile()) fail(path, 'regular file or directory');
    records.push([name, 'file', createHash('sha256').update(readFileSync(path)).digest('hex')]);
  };
  for (const root of manifest.roots) {
    const path = absolute(repositoryRoot, root.path);
    checkAncestors(repositoryRoot, path);
    const info = kind(path);
    if (
      info &&
      (root.kind === 'directory'
        ? !info.isDirectory() && !info.isSymbolicLink()
        : !info.isFile() && !info.isSymbolicLink())
    )
      fail(path, root.kind);
    visit(path, true);
  }
  for (const file of manifest.files) visit(absolute(repositoryRoot, file), false);
  for (const control of manifest.controls) {
    const path = absolute(repositoryRoot, control.path);
    const info = kind(path);
    if (control.kind === 'repository-marker') {
      records.push([
        control.path,
        !info ? 'missing' : info.isDirectory() ? 'directory' : 'file',
        info?.isFile() ? readFileSync(path, 'utf8') : null,
      ]);
      continue;
    }
    if (info && !info.isFile()) fail(path, 'optional ignore control file');
    records.push([
      control.path,
      info ? 'file' : 'missing',
      info ? createHash('sha256').update(readFileSync(path)).digest('hex') : null,
    ]);
  }
  return createHash('sha256')
    .update(JSON.stringify([manifest, sorted(records)]))
    .digest('hex');
}

/** Capture immutable precompile input bytes, including optional ignore-file absence. @example createTailwindInputs(inventory, sources, cssDependencies); */
export function createTailwindInputs(
  inventory: SourceInventory,
  sources: readonly SourcePattern[],
  dependencies: readonly string[]
): TailwindInputs {
  assertDeclaredSources(inventory, sources);
  const { repositoryRoot, projectRoot } = inventory;
  const controls = controlPaths(inventory);
  const marker = kind(join(repositoryRoot, '.git'));
  const outsideControl = controls.some(
    (control) => control.path.base === 'absolute' && kind(control.path.path)
  );
  const files = [
    ...HELPERS.map((name) => join(projectRoot, name)),
    join(repositoryRoot, 'apps/shared/src/frontend-build/host.ts'),
    ...dependencies,
  ];
  const manifest: Omit<TailwindInputs, 'digest'> = {
    version: 1,
    sources: sorted(
      sources.map((source) => ({ ...source, base: posix(relative(repositoryRoot, source.base)) }))
    ),
    roots: inventory.roots,
    files: sorted(
      files.map((path) => {
        canonical(repositoryRoot, path);
        return inputPath(repositoryRoot, path);
      })
    ),
    controls,
    reuse: marker?.isDirectory() && !outsideControl ? 'checked' : 'always-build',
  };
  return { ...manifest, digest: snapshot(repositoryRoot, manifest) };
}

function validPath(value: unknown, allowAbsolute: boolean): value is InputPath {
  if (!object(value) || typeof value.path !== 'string') return false;
  if (value.base === 'absolute') return allowAbsolute && isAbsolute(value.path);
  return (
    value.base === 'repository' &&
    !isAbsolute(value.path) &&
    !value.path.includes('\\') &&
    value.path.split('/').every((part) => part !== '..' && part !== '.')
  );
}
/** Validate a private build stamp before trusting any paths from disk. @example parseTailwindInputs(JSON.parse(text).tailwindInputs); */
export function parseTailwindInputs(value: unknown): TailwindInputs | null {
  if (
    !object(value) ||
    value.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(String(value.digest)) ||
    (value.reuse !== 'checked' && value.reuse !== 'always-build')
  )
    return null;
  if (
    !Array.isArray(value.sources) ||
    !value.sources.every(
      (source) =>
        object(source) &&
        validPath({ base: 'repository', path: source.base }, false) &&
        typeof source.pattern === 'string' &&
        !!source.pattern &&
        !isAbsolute(source.pattern) &&
        typeof source.negated === 'boolean'
    )
  )
    return null;
  if (
    !Array.isArray(value.roots) ||
    !value.roots.every(
      (root) =>
        object(root) &&
        validPath(root.path, false) &&
        (root.kind === 'file' || root.kind === 'directory')
    )
  )
    return null;
  if (!Array.isArray(value.files) || !value.files.every((file) => validPath(file, false)))
    return null;
  if (
    !Array.isArray(value.controls) ||
    !value.controls.every(
      (control) =>
        object(control) &&
        validPath(control.path, true) &&
        (control.kind === 'file' || control.kind === 'repository-marker')
    )
  )
    return null;
  const result = value as unknown as TailwindInputs;
  if (
    [result.sources, result.roots, result.files, result.controls].some(
      (list) => JSON.stringify(list) !== JSON.stringify(sorted<unknown>(list))
    )
  )
    return null;
  return result;
}
/** Recompute a validated precompile stamp; errors fail closed at its callers. @example tailwindInputsAreCurrent(repositoryRoot, manifest); */
export function tailwindInputsAreCurrent(
  repositoryRoot: string,
  manifest: TailwindInputs
): boolean {
  if (!parseTailwindInputs(manifest) || manifest.reuse !== 'checked') return false;
  if (
    JSON.stringify(manifest.controls) !==
    JSON.stringify(controlPaths({ repositoryRoot, roots: manifest.roots }))
  )
    return false;
  const { digest, ...input } = manifest;
  return digest === snapshot(repositoryRoot, input);
}
/** Reject input mutations before atomically publishing a staged build. @example assertTailwindInputsUnchanged(repositoryRoot, manifest); */
export function assertTailwindInputsUnchanged(
  repositoryRoot: string,
  manifest: TailwindInputs
): void {
  const { digest, ...input } = manifest;
  if (
    JSON.stringify(manifest.controls) !==
    JSON.stringify(controlPaths({ repositoryRoot, roots: manifest.roots }))
  )
    fail(repositoryRoot, 'current repository ancestor controls from the precompile snapshot');
  if (digest !== snapshot(repositoryRoot, input))
    fail(repositoryRoot, 'unchanged Tailwind inputs between dependency discovery and publication');
}

/** Decide Turbo cache policy before lookup and validate declared input coverage. @example frontendBuildCacheArguments('/repo'); */
export function frontendBuildCacheArguments(repositoryRoot: string): string[] {
  const inventory = readSourceInventory(join(repositoryRoot, 'apps/frontend'), repositoryRoot);
  const controls = controlPaths(inventory);
  const turbo = JSON.parse(readFileSync(join(inventory.projectRoot, 'turbo.json'), 'utf8')) as {
    tasks?: { build?: { inputs?: string[] } };
  };
  const inputs = turbo.tasks?.build?.inputs ?? [];
  const required = [
    '$TURBO_DEFAULT$',
    ...inventory.roots.map(
      (root) => `$TURBO_ROOT$/${root.path.path}${root.kind === 'directory' ? '/**' : ''}`
    ),
    ...HELPERS.map((path) => path),
    '$TURBO_ROOT$/apps/shared/src/frontend-build/host.ts',
    ...controls
      .filter((control) => control.path.base === 'repository')
      .map((control) => `$TURBO_ROOT$/${control.path.path}`),
  ];
  for (const input of required)
    if (!inputs.includes(input))
      fail(inventory.projectRoot, `Turbo build input ${input} declared in turbo.json`);
  // Snapshot the roots here as well: a nested repository/symlink cannot bypass validation on a cache hit.
  const manifest = createTailwindInputs(inventory, inventory.defaultSources, []);
  return manifest.reuse === 'checked' ? [] : ['--cache=local:,remote:'];
}
