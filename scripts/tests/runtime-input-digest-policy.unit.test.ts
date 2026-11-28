import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import {
  type CompileTimeEnvRead,
  type CrateInput,
  extractBuildScriptHazards,
  extractBuildScriptInputs,
  extractCompileTimeEnvReads,
  extractCrateInputs,
  extractUnresolvedReads,
  isInsideCfgTestModule,
  isMountedUnderCfgTest,
} from '../lib/crate-inputs';
import { type CargoManifest, findRuntimeCrateClosure } from '../lib/runtime-crate-closure';
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

interface RuntimeSource {
  readonly path: string;
  readonly crateDir: string;
  readonly text: string;
}

/** Product-adjacent Rust sources of the crates the runtime links, with their text. */
function runtimeSources(): RuntimeSource[] {
  const sources: RuntimeSource[] = [];
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
 * Reads of a file the digest does not hash, pinned by exact reader file and
 * exact target path. Each is a test read: the reader is a `#[cfg(test)]` module
 * or a file only mounted under `#[cfg(test)]`, which the second test below
 * checks from the source text. A product read belongs in `RUNTIME_INPUT_FILES`;
 * a new read of anything else, even a sibling file in the same directory,
 * fails here until a human adds it with a reason.
 */
const TEST_ONLY_READS: ReadonlyArray<{ source: string; target: string; reason: string }> = [
  {
    source: 'crates/mango-protocol/src/contract.rs',
    target: 'spec/fixtures/1/catalog-example.json',
    reason: 'inside `#[cfg(test)] mod tests`: a #[test] compiles the spec example catalog',
  },
  {
    source: 'crates/mango-protocol/src/schema.rs',
    target: 'spec/schema/1/protocol.json',
    reason: 'inside `#[cfg(test)] mod tests`: the emitted schema is compared with the spec',
  },
  {
    source: 'crates/mango-protocol/src/transports/ipc/unix.rs',
    target: 'spec/fixtures/local-socket-probes.json',
    reason: 'inside `#[cfg(test)] mod tests`: a #[test] replays the shared probe fixture',
  },
  {
    source: 'crates/mangostudio-runtime/src/cli/user_service.rs',
    target: 'crates/mangostudio-runtime/tests/fixtures/windows-service-child-discovery.probe.ps1',
    reason: 'inside `#[cfg(all(test, windows))] mod windows_tests`: a PowerShell fixture',
  },
  {
    source: 'crates/mangostudio-runtime/src/cli/user_service.rs',
    target: 'crates/mangostudio-runtime/tests/fixtures/windows-service-process-lifetimes.probe.ps1',
    reason: 'inside `#[cfg(all(test, windows))] mod windows_tests`: a PowerShell fixture',
  },
  {
    source: 'crates/mangostudio-runtime/src/cli/user_service.rs',
    target: 'crates/mangostudio-runtime/tests/fixtures/windows-service-process-lifetimes.ps1',
    reason: 'inside `#[cfg(all(test, windows))] mod windows_tests`: a PowerShell fixture',
  },
  {
    source: 'crates/mangostudio-runtime/src/library/toml_document.rs',
    target: 'crates/mangostudio-runtime/tests/fixtures/library-toml/validity-cases.json',
    reason: 'inside `#[cfg(test)] mod tests`: a #[test] reads the shared case table at run time',
  },
  {
    source: 'crates/mangostudio-runtime/src/library/mutation/ts_backup_compat_tests.rs',
    target: 'crates/mangostudio-runtime/tests/fixtures/ts-library/corpus.json',
    reason: 'a `_tests.rs` file mounted only under #[cfg(test)] in mutation/mod.rs',
  },
  {
    source: 'crates/mangostudio-runtime/src/library/ts_compat_tests.rs',
    target: 'crates/mangostudio-runtime/tests/fixtures/ts-library/corpus.json',
    reason: 'a `_tests.rs` file mounted only under #[cfg(test)] in library/mod.rs',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/external_agents/adapter/hub_retry_window_tests.rs',
    target: 'apps/api/src/modules/external-agents/application/external-session-manager.ts',
    reason: 'a `_tests.rs` file mounted only under #[cfg(test)] in adapter/backend.rs',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/external_agents/adapter/hub_retry_window_tests.rs',
    target: 'apps/shared/src/external-agents/open-failures.ts',
    reason: 'a `_tests.rs` file mounted only under #[cfg(test)] in adapter/backend.rs',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/external_agents/adapter/hub_sign_in_tests.rs',
    target: 'apps/shared/src/external-agents/remedies.ts',
    reason: 'a `_tests.rs` file mounted only under #[cfg(test)] in adapter/backend.rs',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/external_agents/adapter/map_tests.rs',
    target: 'apps/shared/src/i18n/en.ts',
    reason: 'a `_tests.rs` file mounted only under #[cfg(test)] in adapter/map.rs',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/external_agents/adapter/map_tests.rs',
    target:
      'crates/mangostudio-runtime/tests/fixtures/external-agents/discover-result-before-state.json',
    reason: 'a `_tests.rs` file mounted only under #[cfg(test)] in adapter/map.rs',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/external_agents/product_tests.rs',
    target:
      'crates/mangostudio-runtime/tests/fixtures/external-agents/discover-result-before-state.json',
    reason: 'a `_tests.rs` file mounted only under #[cfg(test)] in external_agents/supervisor.rs',
  },
  {
    source: 'crates/mangostudio-runtime-cold/src/mcp/sdk.rs',
    target: 'crates/mangostudio-runtime/tests/fixtures/mcp_server.mjs',
    reason: 'inside `#[cfg(test)] mod tests`: a helper locates the MCP fixture server at run time',
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

/**
 * SHA-256 of every build script and `build_support` file of the runtime crates
 * (LF-normalized). A build script can reach any file with code the scanner
 * cannot read, so its bytes are pinned: an edit fails here until a human
 * re-justifies the out-of-crate inputs in `RUNTIME_INPUT_FILES`, then updates
 * the hash.
 */
const BUILD_SCRIPT_HASHES: Readonly<Record<string, string>> = {
  'crates/mangostudio-runtime-contract/build.rs':
    '0834bf053f3fb1a8c6a2ce2e9d1cb14663723cfa8aa0a4cd23a9ca1270ecaa38',
  'crates/mangostudio-runtime-contract/build_support/compact_json.rs':
    '03007f5988d3321164f0df12bf88dcea7a1ccf53921b1661826980234517ebff',
};

function isBuildScript(path: string): boolean {
  return /\/build\.rs$/.test(path) || path.includes('/build_support/');
}

function scanReads(): CrateInput[] {
  return runtimeSources().flatMap(({ path, crateDir, text }) => [
    ...extractCrateInputs(path, text, crateDir),
    ...(isBuildScript(path) ? extractBuildScriptInputs(path, text, crateDir) : []),
  ]);
}

function scanEnvReads(): CompileTimeEnvRead[] {
  return runtimeSources().flatMap(({ path, text }) =>
    extractCompileTimeEnvReads(path, text, path.endsWith('/build.rs'))
  );
}

function excused(read: CrateInput): boolean {
  return TEST_ONLY_READS.some(
    (entry) => entry.source === read.source && entry.target === read.path
  );
}

describe('runtime input digest covers every file the runtime crates read', () => {
  test('a read of an unhashed file is a test-only read pinned here, or fails', () => {
    const uncovered = scanReads()
      .filter((read) => !isRuntimeInputPath(read.path) && !excused(read))
      .map((read) => `${read.path} (read at ${read.source}:${read.line})`);
    expect(
      uncovered,
      `expected every compile-time read hashed by RUNTIME_INPUT_FILES or pinned in TEST_ONLY_READS | received unhashed: ${uncovered.join(', ')}`
    ).toEqual([]);
  });

  test('an excused read is still found, still unhashed, and only ever read under cfg(test)', () => {
    const reads = scanReads();
    const sources = runtimeSources();
    for (const entry of TEST_ONLY_READS) {
      expect(
        reads.some((read) => read.source === entry.source && read.path === entry.target),
        `expected ${entry.source} to still read ${entry.target} | received: no such read, drop the TEST_ONLY_READS entry`
      ).toBe(true);
      expect(
        isRuntimeInputPath(entry.target),
        `expected ${entry.target} to stay outside the digest | received: hashed, drop the TEST_ONLY_READS entry`
      ).toBe(false);

      const source = sources.find((candidate) => candidate.path === entry.source);
      if (!source) throw new Error(`expected a runtime source ${entry.source} | received: absent`);
      const basename = entry.source.split('/').at(-1) as string;
      const mounted = sources.some(
        (other) => other.path !== entry.source && isMountedUnderCfgTest(other.text, basename)
      );
      // Every line that can read a file in this source: an include, a manifest-dir join or a
      // `#[path]`. Either the whole file is a test-only module, or each such line is inside one.
      const readLines = source.text
        .split('\n')
        .flatMap((line, index) =>
          /\binclude(?:_str|_bytes)?!|CARGO_MANIFEST_DIR|#\[path/.test(line) &&
          !/^\s*\/\//.test(line)
            ? [index + 1]
            : []
        );
      const outside = readLines.filter((line) => !isInsideCfgTestModule(source.text, line));
      expect(
        mounted || outside.length === 0,
        `expected ${entry.source} to read files only under #[cfg(test)] | received reads outside a test module at line(s) ${outside.join(', ')} and not mounted under cfg(test)`
      ).toBe(true);
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

  test('no include-family macro, wrapper or import is left unresolved', () => {
    const unresolved = runtimeSources()
      .flatMap(({ path, text }) => extractUnresolvedReads(path, text))
      .map((read) => `${read.source}:${read.line} ${read.reason}`);
    expect(
      unresolved,
      `expected every include to name a literal path | received: ${unresolved.join('; ')}`
    ).toEqual([]);
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
});

describe('build scripts', () => {
  const sources = () => runtimeSources().filter(({ path }) => isBuildScript(path));
  const normalized = (text: string) => text.replaceAll('\r\n', '\n');

  test('the set of build scripts and their support files is the pinned one', () => {
    expect(
      sources()
        .map(({ path }) => path)
        .sort(),
      'expected the pinned build script files | received a different set; re-justify the inputs, then pin it'
    ).toEqual(Object.keys(BUILD_SCRIPT_HASHES).sort());
  });

  test('every build script is byte-for-byte the one whose inputs were justified', () => {
    for (const { path, text } of sources()) {
      const actual = createHash('sha256').update(normalized(text)).digest('hex');
      expect(
        actual,
        `${path} changed: a build script can read any file, so a human must re-check that RUNTIME_INPUT_FILES still covers every input it reaches, then update BUILD_SCRIPT_HASHES | expected sha256 ${BUILD_SCRIPT_HASHES[path]} | received: ${actual}`
      ).toBe(BUILD_SCRIPT_HASHES[path] as string);
    }
  });

  test('none uses a path trick the scan cannot follow, and none watches an environment variable', () => {
    const roots = readdirSync(ROOT_DIR).filter((name) => name !== 'crates');
    for (const { path, text } of sources()) {
      expect(
        extractBuildScriptHazards(path, text, roots).map((hazard) => hazard.reason),
        `${path}: build script path hazards`
      ).toEqual([]);
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

describe('runtime input digest covers every workspace crate the runtime links', () => {
  const readManifest = (path: string): CargoManifest =>
    Bun.TOML.parse(readFileSync(join(ROOT_DIR, path), 'utf8')) as CargoManifest;
  const closure = () =>
    findRuntimeCrateClosure('crates/mangostudio-runtime', RUNTIME_CRATE_DIRS, readManifest);

  test('every dependency and patch reachable from the runtime is a declared crate directory', () => {
    expect(closure().problems, 'expected no path outside RUNTIME_CRATE_DIRS').toEqual([]);
  });

  test('the release closure is exactly the declared crates', () => {
    expect([...closure().reachable].sort()).toEqual([...RUNTIME_CRATE_DIRS].sort());
  });

  test('every declared crate directory is a workspace member that exists', () => {
    const members = readManifest('Cargo.toml').workspace?.members ?? [];
    for (const dir of RUNTIME_CRATE_DIRS) {
      expect(
        members,
        `expected ${dir} to be a workspace member | received: ${members.join(', ')}`
      ).toContain(dir);
      expect(existsSync(join(ROOT_DIR, dir, 'Cargo.toml')), `${dir}/Cargo.toml`).toBe(true);
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
