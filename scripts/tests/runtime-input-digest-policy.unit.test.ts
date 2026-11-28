import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import {
  type CompileTimeEnvRead,
  type CrateInput,
  extractBuildScriptInputs,
  extractCompileTimeEnvReads,
  extractCrateInputs,
} from '../lib/crate-inputs';
import {
  isRuntimeInputPath,
  parseIndexListing,
  RUNTIME_CRATE_DIRS,
  RUNTIME_INPUT_FILES,
  selectRuntimeInputs,
} from '../lib/runtime-input-digest';
import { toPosixPath } from '../lib/script-guards';

// The digest (scripts/lib/runtime-input-digest.ts) is only worth anything while
// it covers every input of the runtime binary. These tests scan the crates the
// runtime links and fail when something reaches the compiler that the digest
// does not hash, naming the file and line.

/** Product-adjacent Rust sources of the crates the runtime links, with their text. */
function runtimeSources(): Array<{ path: string; crateDir: string; text: string }> {
  const sources: Array<{ path: string; crateDir: string; text: string }> = [];
  const walk = (crateDir: string, dir: string): void => {
    for (const entry of readdirSync(join(ROOT_DIR, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(crateDir, path);
      else if (entry.name.endsWith('.rs') && isRuntimeInputPath(path)) {
        sources.push({ path, crateDir, text: readFileSync(join(ROOT_DIR, path), 'utf8') });
      }
    }
  };
  for (const crateDir of RUNTIME_CRATE_DIRS) {
    for (const entry of readdirSync(join(ROOT_DIR, crateDir), { withFileTypes: true })) {
      if (entry.isDirectory() && isRuntimeInputPath(`${crateDir}/${entry.name}/x`)) {
        walk(crateDir, `${crateDir}/${entry.name}`);
      } else if (entry.name.endsWith('.rs')) {
        sources.push({
          path: `${crateDir}/${entry.name}`,
          crateDir,
          text: readFileSync(join(ROOT_DIR, crateDir, entry.name), 'utf8'),
        });
      }
    }
  }
  return sources;
}

/**
 * Reads of a file the digest does not hash, each excused by a reason. The
 * reader is always a `#[cfg(test)]` item (or a module mounted under one), so
 * the bytes never reach `cargo build --release`. Adding an entry is a decision
 * that the read is test-only, not a way to silence the scan: a product read
 * belongs in `RUNTIME_INPUT_FILES`.
 */
const TEST_ONLY_READS: ReadonlyArray<{ source: string; target: string; reason: string }> = [
  {
    source: 'crates/mango-protocol/src/contract.rs',
    target: 'spec/',
    reason: 'a #[test] compares the contract with the spec fixture',
  },
  {
    source: 'crates/mango-protocol/src/schema.rs',
    target: 'spec/',
    reason: 'inside `#[cfg(test)] mod tests`: the emitted schema is compared with the spec',
  },
  {
    source: 'crates/mango-protocol/src/transports/ipc/unix.rs',
    target: 'spec/',
    reason: 'a #[test] replays the shared socket-probe fixture',
  },
  {
    source: 'crates/mangostudio-runtime/src/cli/user_service.rs',
    target: 'crates/mangostudio-runtime/tests/fixtures/',
    reason: 'inside `#[cfg(all(test, unix))] mod tests`: PowerShell fixtures',
  },
  {
    source: 'crates/mangostudio-runtime/src/library/toml_document.rs',
    target: 'crates/mangostudio-runtime/tests/fixtures/',
    reason: 'a #[test] reads the shared validity case table at run time',
  },
  {
    source: 'crates/mangostudio-runtime/src/library/mutation/ts_backup_compat_tests.rs',
    target: 'crates/mangostudio-runtime/tests/fixtures/',
    reason: 'a `_tests.rs` module mounted under #[cfg(test)]',
  },
  {
    source: 'crates/mangostudio-runtime/src/library/ts_compat_tests.rs',
    target: 'crates/mangostudio-runtime/tests/fixtures/',
    reason: 'a `_tests.rs` module mounted under #[cfg(test)]',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/external_agents/adapter/hub_retry_window_tests.rs',
    target: 'apps/',
    reason:
      'a `_tests.rs` module mounted under #[cfg(test)]: reads hub sources to compare constants',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/external_agents/adapter/hub_sign_in_tests.rs',
    target: 'apps/shared/src/external-agents/remedies.ts',
    reason: 'a `_tests.rs` module mounted under #[cfg(test)]',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/external_agents/adapter/map_tests.rs',
    target: 'apps/shared/src/i18n/en.ts',
    reason: 'a `_tests.rs` module mounted under #[cfg(test)]',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/external_agents/adapter/map_tests.rs',
    target: 'crates/mangostudio-runtime/tests/fixtures/',
    reason: 'a `_tests.rs` module mounted under #[cfg(test)]',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/external_agents/product_tests.rs',
    target: 'crates/mangostudio-runtime/tests/fixtures/',
    reason: 'a `_tests.rs` module mounted under #[cfg(test)]',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/mcp/sdk.rs',
    target: 'crates/mangostudio-runtime/tests/fixtures/',
    reason: 'a #[test] helper locates the MCP fixture server at run time',
  },
];

/** Environment variables cargo supplies from manifests, covered by the manifests being hashed. */
const CARGO_SUPPLIED_ENV = /^(?:CARGO_PKG_[A-Z_]+|CARGO_MANIFEST_DIR|CARGO_CRATE_NAME|OUT_DIR)$/;

/** Any other compile-time environment read, each excused by a reason. */
const TEST_ONLY_ENV_READS: ReadonlyArray<{ source: string; name: string; reason: string }> = [
  {
    source: 'crates/mangostudio-runtime/src/library/settings_sources.rs',
    name: 'GITHUB_ACTIONS',
    reason: 'inside a `#[cfg(windows)] #[test]`',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/external_agents/adapter/map_events_bench.rs',
    name: 'MANGOSTUDIO_BENCH_SOURCE_SHA',
    reason: 'mounted under #[cfg(test)] in map_events.rs',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/external_agents/turns_bench.rs',
    name: 'MANGOSTUDIO_BENCH_SOURCE_SHA',
    reason: 'mounted under #[cfg(test)] in turns.rs',
  },
];

/** `build.rs` files of the runtime crates: pinned so a new one is reviewed here. */
const BUILD_SCRIPTS = ['crates/mangostudio-runtime-contract/build.rs'];

function scanReads(): CrateInput[] {
  return runtimeSources().flatMap(({ path, crateDir, text }) => [
    ...extractCrateInputs(path, text, crateDir),
    ...(path.endsWith('/build.rs') || path.includes('/build_support/')
      ? extractBuildScriptInputs(path, text, crateDir)
      : []),
  ]);
}

function scanEnvReads(): CompileTimeEnvRead[] {
  return runtimeSources().flatMap(({ path, text }) =>
    extractCompileTimeEnvReads(path, text, path.endsWith('/build.rs'))
  );
}

/** Whether the digest hashes the file a read resolves to. */
function hashed(path: string): boolean {
  return isRuntimeInputPath(path);
}

function excused(read: CrateInput): boolean {
  return TEST_ONLY_READS.some(
    (entry) => entry.source === read.source && read.path.startsWith(entry.target)
  );
}

describe('runtime input digest covers every file the runtime crates read', () => {
  test('a read of an unhashed file is a test-only read named here, or fails', () => {
    const uncovered = scanReads()
      .filter((read) => !hashed(read.path) && !excused(read))
      .map((read) => `${read.path} (read at ${read.source}:${read.line})`);
    expect(
      uncovered,
      `expected every compile-time read hashed by RUNTIME_INPUT_FILES or excused in TEST_ONLY_READS | received unhashed: ${uncovered.join(', ')}`
    ).toEqual([]);
  });

  test('an excused read is still found, and still outside the digest', () => {
    const reads = scanReads();
    for (const entry of TEST_ONLY_READS) {
      const found = reads.filter(
        (read) => read.source === entry.source && read.path.startsWith(entry.target)
      );
      expect(
        found.length,
        `expected ${entry.source} to still read ${entry.target} | received: no such read, drop the TEST_ONLY_READS entry`
      ).toBeGreaterThan(0);
      for (const read of found) {
        expect(
          hashed(read.path),
          `expected ${read.path} to stay outside the digest | received: hashed, drop the TEST_ONLY_READS entry`
        ).toBe(false);
      }
    }
  });

  test('the scan finds the product reads known today, so a broken pattern cannot pass vacuously', () => {
    const paths = new Set(scanReads().map((read) => read.path));
    for (const known of RUNTIME_INPUT_FILES.filter((path) => path.startsWith('apps/'))) {
      expect(
        paths,
        `expected the scan to find ${known} | received: ${[...paths].join(', ')}`
      ).toContain(known);
    }
  });

  test('every declared out-of-crate input is read by a runtime crate', () => {
    const read = new Set(scanReads().map((entry) => entry.path));
    for (const path of RUNTIME_INPUT_FILES.filter((entry) => entry.startsWith('apps/'))) {
      expect(
        read.has(path),
        `expected ${path} to be read by a runtime crate | received: unread, drop it from RUNTIME_INPUT_FILES`
      ).toBe(true);
    }
  });

  test('compile-time environment reads are cargo-supplied or excused', () => {
    const unexpected = scanEnvReads()
      .filter(
        (read) =>
          !CARGO_SUPPLIED_ENV.test(read.name) &&
          !TEST_ONLY_ENV_READS.some(
            (entry) => entry.source === read.source && entry.name === read.name
          )
      )
      .map((read) => `${read.name} (${read.source}:${read.line})`);
    expect(
      unexpected,
      `expected only cargo-supplied variables or TEST_ONLY_ENV_READS | received: ${unexpected.join(', ')}`
    ).toEqual([]);
    for (const entry of TEST_ONLY_ENV_READS) {
      expect(
        scanEnvReads().some((read) => read.source === entry.source && read.name === entry.name),
        `expected ${entry.source} to still read ${entry.name} | received: gone, drop the TEST_ONLY_ENV_READS entry`
      ).toBe(true);
    }
  });

  test('build scripts are the pinned set, and rerun-if-env-changed is not used', () => {
    const found = runtimeSources()
      .map((source) => source.path)
      .filter((path) => path.endsWith('/build.rs'))
      .sort();
    expect(found, 'expected the pinned build.rs set | received a different one').toEqual(
      BUILD_SCRIPTS
    );
    for (const { path, text } of runtimeSources()) {
      expect(text, `${path}: a build script env dependency needs a digest entry`).not.toContain(
        'rerun-if-env-changed'
      );
    }
    for (const crateDir of RUNTIME_CRATE_DIRS) {
      const manifest = readFileSync(join(ROOT_DIR, crateDir, 'Cargo.toml'), 'utf8');
      expect(manifest, `${crateDir}/Cargo.toml: a custom build path needs review here`).not.toMatch(
        /^\s*build\s*=/m
      );
    }
  });
});

interface ManifestTable {
  readonly package?: { readonly name?: string };
  readonly dependencies?: Record<string, { readonly package?: string } | string>;
  readonly 'build-dependencies'?: Record<string, { readonly package?: string } | string>;
  readonly target?: Record<string, Pick<ManifestTable, 'dependencies' | 'build-dependencies'>>;
}

function parseManifest(path: string): ManifestTable {
  return Bun.TOML.parse(readFileSync(join(ROOT_DIR, path), 'utf8')) as ManifestTable;
}

/** Names of dependencies a release build of the package compiles: no dev-dependencies. */
function releaseDependencyNames(manifest: ManifestTable): string[] {
  const tables = [
    manifest.dependencies,
    manifest['build-dependencies'],
    ...Object.values(manifest.target ?? {}).flatMap((target) => [
      target.dependencies,
      target['build-dependencies'],
    ]),
  ];
  return tables.flatMap((table) =>
    Object.entries(table ?? {}).map(([key, value]) =>
      typeof value === 'object' && value.package ? value.package : key
    )
  );
}

describe('runtime input digest covers every workspace crate the runtime links', () => {
  const root = Bun.TOML.parse(readFileSync(join(ROOT_DIR, 'Cargo.toml'), 'utf8')) as {
    workspace: { members: string[] };
  };
  const dirByName = new Map(
    root.workspace.members.map((dir) => [parseManifest(`${dir}/Cargo.toml`).package?.name, dir])
  );

  function closureOf(name: string, seen = new Set<string>()): Set<string> {
    const dir = dirByName.get(name);
    if (!dir || seen.has(name)) return seen;
    seen.add(name);
    for (const dependency of releaseDependencyNames(parseManifest(`${dir}/Cargo.toml`))) {
      closureOf(dependency, seen);
    }
    return seen;
  }

  test('every member in the runtime closure is a declared crate directory', () => {
    const closure = [...closureOf('mangostudio-runtime')].map((name) => dirByName.get(name));
    expect(
      closure.length,
      'expected the closure to include the runtime and its path dependencies | received: fewer than 5'
    ).toBeGreaterThanOrEqual(5);
    const missing = closure.filter((dir) => !RUNTIME_CRATE_DIRS.includes(dir as string));
    expect(
      missing,
      `expected RUNTIME_CRATE_DIRS to include every crate the runtime links | received missing: ${missing.join(', ')}`
    ).toEqual([]);
  });

  test('every declared crate directory is a workspace member that exists', () => {
    for (const dir of RUNTIME_CRATE_DIRS) {
      expect(
        root.workspace.members,
        `expected ${dir} to be a workspace member | received: ${root.workspace.members.join(', ')}`
      ).toContain(dir);
      expect(existsSync(join(ROOT_DIR, dir, 'Cargo.toml')), `${dir}/Cargo.toml`).toBe(true);
    }
  });

  test('the release closure never reaches a path dependency outside crates/', () => {
    for (const name of closureOf('mangostudio-runtime')) {
      const manifest = readFileSync(
        join(ROOT_DIR, dirByName.get(name) as string, 'Cargo.toml'),
        'utf8'
      );
      for (const match of manifest.matchAll(/path\s*=\s*"([^"]+)"/g)) {
        expect(
          match[1],
          `expected ${name} to depend on paths inside its crate or src/tests only | received: ${match[1]}`
        ).not.toMatch(/^\.\./);
      }
    }
  });
});

describe('the declared inputs are tracked', () => {
  test('the repository index satisfies selectRuntimeInputs', () => {
    const listing = Bun.spawnSync({ cmd: ['git', 'ls-files', '-s', '-z'], cwd: ROOT_DIR });
    expect(listing.exitCode, 'expected git ls-files -s to exit 0').toBe(0);
    const files = selectRuntimeInputs(parseIndexListing(listing.stdout.toString()));
    const paths = new Set(files.map((file) => file.path));
    for (const path of RUNTIME_INPUT_FILES) expect(paths, `${path} is tracked`).toContain(path);
    expect(
      [...paths].filter((path) => toPosixPath(path) !== path),
      'expected POSIX paths from git'
    ).toEqual([]);
    expect(paths.has('crates/mangostudio-runtime/src/main.rs')).toBe(true);
    expect(paths.has('crates/mangostudio-launcher/src/main.rs')).toBe(false);
  });
});
