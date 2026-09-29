// Component registry: the set of units the QA report measures, discovered
// from the repository instead of listed by hand.
//
//   JS workspaces  root package.json `workspaces` globs, matched against the
//                  directories of tracked package.json files
//   Rust crates    root Cargo.toml `[workspace].members` / `exclude`, read
//                  with a TOML parser. Deliberately not `cargo metadata`:
//                  `rust-toolchain.toml` pins a toolchain, so a rustup-proxied
//                  cargo in a lane that only installed Bun tries to download
//                  it (network) or fails, and the Rust components would
//                  vanish or hang the job. The manifests already say which
//                  directories are members and what each is called.
//   scripts/       one explicit mapping (it is neither a workspace nor a crate)
//
// Ownership is longest-root-prefix, so a nested root (a fixture package inside
// an app, the excluded `crates/mango-protocol/fuzz` workspace inside the
// protocol crate) is counted once, under its parent. A tracked file that no
// component owns and that is not on the explicit non-component list fails
// integrity: a new top-level directory (or a removed mapping) is an error to
// fix, never files silently dropped from the totals.

import { dirname } from 'node:path/posix';

import type { ComponentKind } from '../model/metrics';

/** A discovered component before any measurement is attached. */
export interface ComponentSpec {
  readonly id: string;
  readonly kind: ComponentKind;
  readonly name: string;
  /** Repository-relative directory that owns the component's files. */
  readonly root: string;
  /** True when `<root>/tsconfig.json` is tracked, so a type-check is defined. */
  readonly hasTsconfig: boolean;
}

/** A directory that is a component although no manifest declares it. */
export interface ExtraMapping {
  readonly kind: ComponentKind;
  readonly name: string;
  readonly root: string;
}

/** `scripts/` is Bun-native tooling with no package manifest of its own. */
const DEFAULT_EXTRA_MAPPINGS: readonly ExtraMapping[] = [
  { kind: 'scripts', name: 'scripts', root: 'scripts' },
];

/**
 * Top-level directories that hold tracked files but are deliberately not
 * components: prose, wire-spec data, patches and browser-smoke specs. Any
 * other top-level directory with tracked files must be owned by a component.
 * Dot-directories (`.github`, `.claude`, ...) and files directly at the
 * repository root are tooling and never components.
 */
const NON_COMPONENT_DIRECTORIES: readonly string[] = ['docs', 'patches', 'spec', 'tests'];

export interface RegistryInput {
  /** Repository-relative tracked file paths (`git ls-files`). */
  readonly trackedFiles: readonly string[];
  /** Reads a tracked text file by repository-relative path. */
  readonly readText: (path: string) => Promise<string>;
  readonly extraMappings?: readonly ExtraMapping[];
}

/** Where an integrity failure is fixed; named in the error so the fix is one click away. */
export const REGISTRY_SOURCE = 'scripts/qa-gate/collect/registry.ts';

/** Thrown when discovery cannot account for every tracked file or manifest. */
export class RegistryIntegrityError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(
      `component registry integrity failed:\n- ${problems.join('\n- ')}\n` +
        `To fix: add the directory to a workspace/crate root or the extra mappings, or list it in NON_COMPONENT_DIRECTORIES, in ${REGISTRY_SOURCE}`
    );
    this.name = 'RegistryIntegrityError';
  }
}

const isUnder = (path: string, root: string): boolean => path.startsWith(`${root}/`);

const globMatcher = (patterns: readonly string[]): ((dir: string) => boolean) => {
  const positive = patterns.filter((pattern) => !pattern.startsWith('!'));
  const negative = patterns.filter((pattern) => pattern.startsWith('!')).map((p) => p.slice(1));
  const matchAny = (list: readonly string[], dir: string): boolean =>
    list.some((pattern) =>
      new Bun.Glob(pattern.replace(/^\.\//, '').replace(/\/$/, '')).match(dir)
    );
  return (dir) => matchAny(positive, dir) && !matchAny(negative, dir);
};

const manifestDirs = (trackedFiles: readonly string[], manifest: string): string[] =>
  trackedFiles
    .filter((path) => path.endsWith(`/${manifest}`))
    .map((path) => dirname(path))
    .sort();

const parseJsonObject = (path: string, text: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RegistryIntegrityError([
      `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); expected an object`,
    ]);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RegistryIntegrityError([
      `${path} parsed to ${JSON.stringify(parsed)}; expected a JSON object`,
    ]);
  }
  return parsed as Record<string, unknown>;
};

const parseTomlObject = (path: string, text: string): Record<string, unknown> => {
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new RegistryIntegrityError([
      `${path} is not valid TOML (${err instanceof Error ? err.message : String(err)}); expected a Cargo manifest`,
    ]);
  }
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const workspacePatterns = (rootManifest: Record<string, unknown>): string[] => {
  const declared = rootManifest.workspaces;
  if (Array.isArray(declared)) return stringList(declared);
  if (typeof declared === 'object' && declared !== null) {
    return stringList((declared as { packages?: unknown }).packages);
  }
  return [];
};

const discoverWorkspaces = async (
  input: RegistryInput,
  problems: string[]
): Promise<ComponentSpec[]> => {
  const rootManifest = parseJsonObject('package.json', await input.readText('package.json'));
  const isWorkspace = globMatcher(workspacePatterns(rootManifest));
  const specs: ComponentSpec[] = [];
  for (const dir of manifestDirs(input.trackedFiles, 'package.json').filter(isWorkspace)) {
    const manifestPath = `${dir}/package.json`;
    const name = parseJsonObject(manifestPath, await input.readText(manifestPath)).name;
    if (typeof name !== 'string' || name === '') {
      problems.push(
        `${manifestPath} has name ${JSON.stringify(name)}; expected a non-empty string`
      );
      continue;
    }
    specs.push(makeSpec('workspace', name, dir, input.trackedFiles));
  }
  return specs;
};

interface CrateDiscovery {
  readonly crates: ComponentSpec[];
  readonly excludedRoots: string[];
}

const discoverCrates = async (
  input: RegistryInput,
  problems: string[]
): Promise<CrateDiscovery> => {
  if (!input.trackedFiles.includes('Cargo.toml')) return { crates: [], excludedRoots: [] };
  const root = parseTomlObject('Cargo.toml', await input.readText('Cargo.toml'));
  const workspace = (root.workspace ?? {}) as { members?: unknown; exclude?: unknown };
  if (root.package !== undefined) {
    problems.push(
      'Cargo.toml declares a root [package]; expected a virtual workspace (members only) so every crate has its own directory'
    );
  }
  const isMember = globMatcher(stringList(workspace.members));
  const excludedRoots = stringList(workspace.exclude).map((path) => path.replace(/\/$/, ''));
  const specs: ComponentSpec[] = [];
  for (const dir of manifestDirs(input.trackedFiles, 'Cargo.toml').filter(isMember)) {
    const manifestPath = `${dir}/Cargo.toml`;
    const pkg = (parseTomlObject(manifestPath, await input.readText(manifestPath)).package ??
      {}) as { name?: unknown };
    if (typeof pkg.name !== 'string' || pkg.name === '') {
      problems.push(
        `${manifestPath} has [package].name ${JSON.stringify(pkg.name)}; expected a non-empty string`
      );
      continue;
    }
    specs.push(makeSpec('crate', pkg.name, dir, input.trackedFiles));
  }
  return { crates: specs, excludedRoots };
};

const makeSpec = (
  kind: ComponentKind,
  name: string,
  root: string,
  trackedFiles: readonly string[]
): ComponentSpec => ({
  id: `${kind}:${name}`,
  kind,
  name,
  root,
  hasTsconfig: kind !== 'crate' && trackedFiles.includes(`${root}/tsconfig.json`),
});

const isNonComponentPath = (path: string): boolean => {
  const [top] = path.split('/');
  if (!path.includes('/')) return true;
  return top.startsWith('.') || NON_COMPONENT_DIRECTORIES.includes(top);
};

const checkUniqueness = (specs: readonly ComponentSpec[], problems: string[]): void => {
  for (const key of ['id', 'root'] as const) {
    const seen = new Set<string>();
    for (const spec of specs) {
      if (seen.has(spec[key])) {
        problems.push(`two components share ${key} ${spec[key]}; expected each ${key} once`);
      }
      seen.add(spec[key]);
    }
  }
};

const checkManifestsOwned = (
  input: RegistryInput,
  specs: readonly ComponentSpec[],
  excludedRoots: readonly string[],
  problems: string[]
): void => {
  const owned = (dir: string): boolean =>
    specs.some((spec) => spec.root === dir || isUnder(dir, spec.root)) ||
    excludedRoots.some((root) => dir === root || isUnder(dir, root));
  for (const manifest of ['package.json', 'Cargo.toml']) {
    for (const dir of manifestDirs(input.trackedFiles, manifest)) {
      if (owned(dir) || isNonComponentPath(`${dir}/${manifest}`)) continue;
      problems.push(
        `${dir}/${manifest} is not a member of the root ${manifest === 'Cargo.toml' ? '[workspace].members' : '"workspaces"'} globs and is not nested in a component; expected it to be listed or excluded`
      );
    }
  }
};

const checkMappingsExist = (
  input: RegistryInput,
  mappings: readonly ExtraMapping[],
  problems: string[]
): void => {
  for (const mapping of mappings) {
    if (input.trackedFiles.some((path) => isUnder(path, mapping.root))) continue;
    problems.push(
      `mapping ${mapping.kind}:${mapping.name} has no tracked files under ${mapping.root}/`
    );
  }
};

const checkEveryFileOwned = (
  trackedFiles: readonly string[],
  specs: readonly ComponentSpec[],
  problems: string[]
): void => {
  const unowned = new Map<string, string[]>();
  for (const path of trackedFiles) {
    if (ownerOf(specs, path) || isNonComponentPath(path)) continue;
    const top = path.split('/')[0];
    unowned.set(top, [...(unowned.get(top) ?? []), path]);
  }
  for (const [top, paths] of unowned) {
    problems.push(
      `${paths.length} tracked file(s) under ${top}/ (e.g. ${paths[0]}) are owned by no component; expected a workspace/crate/mapping root containing them, or ${top} listed in NON_COMPONENT_DIRECTORIES`
    );
  }
};

/**
 * The component whose root is the longest prefix of `path`, or null.
 * // Usage: ownerOf(specs, 'crates/mango-protocol/fuzz/src/a.rs')?.name
 */
export const ownerOf = (specs: readonly ComponentSpec[], path: string): ComponentSpec | null => {
  let best: ComponentSpec | null = null;
  for (const spec of specs) {
    if (!isUnder(path, spec.root)) continue;
    if (best === null || spec.root.length > best.root.length) best = spec;
  }
  return best;
};

/**
 * Discover every component and prove no tracked file or manifest is lost.
 * Throws RegistryIntegrityError listing every problem found.
 * // Usage: const specs = await discoverComponents({ trackedFiles, readText });
 */
export const discoverComponents = async (input: RegistryInput): Promise<ComponentSpec[]> => {
  const problems: string[] = [];
  const mappings = input.extraMappings ?? DEFAULT_EXTRA_MAPPINGS;
  const workspaces = await discoverWorkspaces(input, problems);
  const { crates, excludedRoots } = await discoverCrates(input, problems);
  const extras = mappings.map((mapping) =>
    makeSpec(mapping.kind, mapping.name, mapping.root, input.trackedFiles)
  );
  const specs = [...workspaces, ...crates, ...extras].sort((a, b) => a.root.localeCompare(b.root));

  checkUniqueness(specs, problems);
  checkMappingsExist(input, mappings, problems);
  checkManifestsOwned(input, specs, excludedRoots, problems);
  checkEveryFileOwned(input.trackedFiles, specs, problems);
  if (problems.length > 0) throw new RegistryIntegrityError(problems);
  return specs;
};
