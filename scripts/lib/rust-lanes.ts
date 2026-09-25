// The single manifest for `.github/workflows/cargo-shim.yml`'s conditional
// lanes: which changed paths make the Rust workspace lanes relevant, which
// make the real-binary qualification lane relevant, and which api test files
// that lane runs. The workflow's push filter, its `changes` job, its test
// steps, and `scripts/tests/rust-lanes.unit.test.ts` all read from here, so
// no second hand-maintained list can drift from it.
//
// Dependency-free (Node built-ins only): the `changes` and qualification jobs
// run it without `bun install`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Paths whose change makes the Rust workspace lanes (fmt, clippy, tests,
 * MSRV, musl clippy, fuzz metadata, fixture freshness) relevant: the cargo
 * workspace itself, and the TypeScript halves of the shapes it reads and
 * writes (the generated runtime contract, runtime-home slot shapes and the
 * schemas they import, and the library readers the runtime answers for).
 * GitHub `paths` glob syntax.
 */
export const RUST_WORKSPACE_PATHS = [
  'crates/**',
  'apps/shared/src/runtime-contract/**',
  'apps/shared/src/runtime-home/**',
  'apps/shared/src/external-agents/**',
  'apps/shared/src/schema-helpers.ts',
  'apps/shared/src/environments/toolchain-schemas.ts',
  'apps/shared/src/library/**',
  'apps/shared/src/markdown/**',
  'Cargo.toml',
  'Cargo.lock',
  'deny.toml',
  'rustfmt.toml',
  'rust-toolchain.toml',
  '.cargo/config.toml',
  '.github/workflows/cargo-shim.yml',
  '.github/actions/setup-zigbuild/**',
] as const;

/**
 * Paths whose change makes `real-binary-qualification` relevant: everything
 * that feeds the Rust workspace, plus the whole hub and shared tree. Every
 * hub module can reach the runtime (Local is the Rust binary), so the lane
 * does not guess which ones do; a frontend- or docs-only change still skips.
 */
export const QUALIFICATION_PATHS = [
  ...RUST_WORKSPACE_PATHS,
  'apps/api/**',
  'apps/shared/**',
  'package.json',
  'bun.lock',
  '.bun-version',
  'patches/**',
  'scripts/lib/rust-lanes.ts',
  'scripts/ci/rust-lanes.ts',
] as const;

/** The api workspace, relative to the repository root. */
export const API_DIR = 'apps/api';

/**
 * The resolver every Rust-backed api test reaches, directly or through a
 * support module: a test file whose relative-import closure contains it
 * spawns or dials the real `mangostudio-runtime` binary.
 */
export const RUST_BINARY_RESOLVER = 'apps/api/tests/support/rust-runtime-binary.ts';

export interface LaneRelevance {
  /** The Rust workspace lanes must run. */
  readonly rust: boolean;
  /** The real-binary qualification lane must run. */
  readonly qualification: boolean;
}

/**
 * True when `path` matches one of the GitHub `paths` globs.
 *
 * @example
 * matchesAnyPath('crates/x/src/lib.rs', ['crates/**']); // true
 */
function matchesAnyPath(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => new Bun.Glob(glob).match(path));
}

/**
 * Classifies a pull request's changed paths into the lanes they make
 * relevant. An empty list is refused rather than read as "nothing relevant",
 * so a broken diff can never skip a lane.
 *
 * @example
 * classifyChangedPaths(['apps/api/src/services/tools/arg-parsing.ts']);
 * // { rust: false, qualification: true }
 */
export function classifyChangedPaths(paths: readonly string[]): LaneRelevance {
  const changed = paths.map((path) => path.trim()).filter(Boolean);
  if (changed.length === 0) {
    throw new Error(
      'rust-lanes: no changed paths to classify; expected at least one repository-relative path'
    );
  }
  return {
    rust: changed.some((path) => matchesAnyPath(path, RUST_WORKSPACE_PATHS)),
    qualification: changed.some((path) => matchesAnyPath(path, QUALIFICATION_PATHS)),
  };
}

export interface QualificationSuites {
  /** Test files under `tests/unit/`, run on one isolated worker like the unit lane. */
  readonly unit: readonly string[];
  /** Every other Rust-backed test file. */
  readonly integration: readonly string[];
}

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function listSources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listSources(path));
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

function resolveImport(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = base + extension;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this extension; try the next one.
    }
  }
  return undefined;
}

function relativeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const imports: string[] = [];
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const resolved = resolveImport(file, match[1] as string);
    if (resolved) imports.push(resolved);
  }
  return imports;
}

function reachesResolver(
  file: string,
  resolver: string,
  memo: Map<string, boolean>,
  visiting: Set<string>
): boolean {
  const known = memo.get(file);
  if (known !== undefined) return known;
  if (file === resolver) return true;
  if (visiting.has(file)) return false;
  visiting.add(file);
  const reaches = relativeImports(file).some((next) =>
    reachesResolver(next, resolver, memo, visiting)
  );
  visiting.delete(file);
  memo.set(file, reaches);
  return reaches;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * Finds every Rust-backed test file under `<root>/apps/api/tests`: a
 * `*.test.ts` whose relative-import closure reaches
 * {@link RUST_BINARY_RESOLVER}. Paths are relative to `apps/api`, sorted,
 * split into the unit and integration suites.
 *
 * @example
 * const { unit, integration } = discoverQualificationTests(process.cwd());
 */
export function discoverQualificationTests(root: string): QualificationSuites {
  const apiDir = join(root, API_DIR);
  const resolver = join(root, RUST_BINARY_RESOLVER);
  const memo = new Map<string, boolean>();
  const unit: string[] = [];
  const integration: string[] = [];
  const tests = listSources(join(apiDir, 'tests')).filter((file) => file.endsWith('.test.ts'));
  for (const file of tests) {
    if (!reachesResolver(file, resolver, memo, new Set())) continue;
    const path = toPosix(relative(apiDir, file));
    (path.startsWith('tests/unit/') ? unit : integration).push(path);
  }
  return { unit: unit.sort(), integration: integration.sort() };
}
