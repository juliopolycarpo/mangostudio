import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { SUITE_FLAGS } from '../ci/rust-lanes';
import { ROOT_DIR } from '../lib/config';
import {
  API_DIR,
  classifyChangedPaths,
  discoverQualificationTests,
  OPT_IN_TESTS,
  QUALIFICATION_PATHS,
  RUST_BINARY_RESOLVER,
  RUST_WORKSPACE_PATHS,
} from '../lib/rust-lanes';
import { extractCrateInputs, scanCrateInputs } from './support/crate-inputs';
import { readText } from './support/read-text';
import { extractOnBlock } from './support/workflow-blocks';

// scripts/lib/rust-lanes.ts is the one manifest behind cargo-shim.yml's
// conditional lanes. These tests pin the workflow to it and fail when a test
// file that needs the real runtime binary would not run in
// real-binary-qualification.

const workflow = readText('.github/workflows/cargo-shim.yml');
const discovered = discoverQualificationTests(ROOT_DIR);
const selected = new Set([...discovered.unit, ...discovered.integration, ...OPT_IN_TESTS]);

function apiTestFiles(dir = join(ROOT_DIR, API_DIR, 'tests')): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...apiTestFiles(path));
    else if (entry.name.endsWith('.test.ts')) files.push(path);
  }
  return files;
}

function apiRelative(path: string): string {
  return relative(join(ROOT_DIR, API_DIR), path).split(sep).join('/');
}

describe('cargo-shim.yml push filter', () => {
  test('lists exactly QUALIFICATION_PATHS, in order', () => {
    const pushPaths = [...extractOnBlock(workflow).matchAll(/^ {6}- "([^"]+)"$/gm)].map(
      (match) => match[1]
    );
    expect(pushPaths).toEqual([...QUALIFICATION_PATHS]);
  });

  test('every glob is an exact path or a directory tree, so GitHub and Bun.Glob agree', () => {
    // The push filter is matched by GitHub, the PR diff by Bun.Glob. Their
    // syntaxes differ on `*`, braces, character classes, and `!`; restricting
    // the manifest to these two shapes keeps both matchers on the same answer.
    for (const glob of QUALIFICATION_PATHS) {
      const body = glob.endsWith('/**') ? glob.slice(0, -3) : glob;
      expect(body, `unsupported glob shape: ${glob}`).not.toMatch(/[*?[\]{}!]/);
    }
  });

  test.each([
    ['crates/**', 'crates/a/b/c.rs', true],
    ['crates/**', 'crates', false],
    ['crates/**', 'cratesx/a.rs', false],
    ['apps/api/**', 'apps/api/package.json', true],
    ['apps/api/**', 'apps/api-docs/x.md', false],
    ['Cargo.toml', 'Cargo.toml', true],
    ['Cargo.toml', 'crates/x/Cargo.toml', false],
    ['.cargo/config.toml', '.cargo/config.toml', true],
  ] as const)('%s matches %s: %p', (glob, path, expected) => {
    expect(new Bun.Glob(glob).match(path)).toBe(expected);
  });

  test('every Rust workspace path also triggers qualification', () => {
    for (const path of RUST_WORKSPACE_PATHS) {
      expect(QUALIFICATION_PATHS as readonly string[], `missing ${path}`).toContain(path);
    }
  });
});

describe('classifyChangedPaths', () => {
  test.each([
    ['crates/mangostudio-runtime/src/lib.rs', true, true],
    // A runtime-only edit, including Windows-only code, runs every Rust lane.
    ['crates/mangostudio-runtime/src/filesystem/io.rs', true, true],
    ['Cargo.lock', true, true],
    ['apps/shared/src/runtime-home/schemas.ts', true, true],
    // #1099: hub modules the qualification suites exercise but no list named.
    ['apps/api/src/services/tools/arg-parsing.ts', false, true],
    ['apps/api/src/modules/environments/application/environment-service.ts', false, true],
    ['apps/api/tests/support/rust-runtime-binary.ts', false, true],
    ['apps/shared/src/i18n/pt-BR.ts', false, true],
    ['apps/shared/src/i18n/en.ts', false, true],
    ['scripts/lib/rust-lanes.ts', false, true],
    ['packages/protocol/src/session.ts', false, true],
    // Files a crate reads from outside crates/: a change must run the crate.
    ['spec/schema/1/protocol.json', true, true],
    ['spec/fixtures/1/negotiation.json', true, true],
    ['scripts/tests/support/SHA256SUMS.sample', true, true],
    ['packages/protocol/src/testing/conformance.ts', true, true],
    ['apps/frontend/src/main.tsx', false, false],
    ['docs/reference/releasing.md', false, false],
    ['docs/protocol/conformance.md', false, false],
    ['scripts/protocol/check.ts', false, false],
  ] as const)('%s -> rust=%p qualification=%p', (path, rust, qualification) => {
    expect(classifyChangedPaths([path])).toEqual({ rust, qualification });
  });

  test('one relevant path in a mixed diff is enough', () => {
    expect(classifyChangedPaths(['docs/a.md', '', 'crates/x/Cargo.toml'])).toEqual({
      rust: true,
      qualification: true,
    });
  });

  test('an empty diff is refused rather than skipping every lane', () => {
    expect(() => classifyChangedPaths(['', '  '])).toThrow(
      'rust-lanes: no changed paths to classify; expected at least one repository-relative path'
    );
  });
});

/**
 * Crate inputs that deliberately do NOT select the rust lane, each mapped to
 * the test that guards the same direction in a lane that already runs on that
 * path's edits. Adding to this list is a decision, not a fix: prefer a glob.
 */
const CRATE_INPUTS_COVERED_ELSEWHERE: Readonly<Record<string, string>> = {
  // `every_key_in_the_table_is_one_the_frontend_ships` (Rust) guards
  // Rust -> catalog whenever Rust changes; en.ts is edited on far more PRs than
  // Rust is, so the catalog -> Rust direction lives in the shared lane instead.
  'apps/shared/src/i18n/en.ts': 'apps/shared/tests/unit/i18n-rust-keys.test.ts',
};

describe('files a crate reads from outside crates/', () => {
  test('every one selects the rust lane, so a change to it cannot skip the crate that reads it', () => {
    const uncovered = scanCrateInputs(ROOT_DIR)
      .filter((input) => !(input.path in CRATE_INPUTS_COVERED_ELSEWHERE))
      // A trailing `/` names a directory the source appends a file name to.
      .filter((input) => !classifyChangedPaths([input.path.replace(/\/$/, '/file')]).rust)
      .map((input) => `${input.path} (read at ${input.source}:${input.line})`);
    expect(
      uncovered,
      `expected rust lane to cover every crate input | received: rust=false for ${uncovered.join(', ')}`
    ).toEqual([]);
  });

  test('an input excused from the lane is still found, still outside it, and its guard exists', () => {
    const found = new Set(scanCrateInputs(ROOT_DIR).map((input) => input.path));
    for (const [path, guard] of Object.entries(CRATE_INPUTS_COVERED_ELSEWHERE)) {
      expect(found.has(path), `expected the scan to still find ${path} | received: gone`).toBe(
        true
      );
      expect(
        classifyChangedPaths([path]).rust,
        `expected ${path} to stay outside the rust lane | received: rust=true, drop its entry from CRATE_INPUTS_COVERED_ELSEWHERE`
      ).toBe(false);
      expect(
        Bun.file(join(ROOT_DIR, guard)).size,
        `expected the guard for ${path} at ${guard} | received: missing or empty`
      ).toBeGreaterThan(0);
    }
  });

  test('the scan finds the inputs known today, so a broken pattern cannot pass vacuously', () => {
    const paths = new Set(scanCrateInputs(ROOT_DIR).map((input) => input.path));
    for (const known of [
      'spec/schema/1/protocol.json',
      'spec/fixtures/1/catalog-example.json',
      'spec/fixtures/1/',
      'scripts/tests/support/SHA256SUMS.sample',
      'packages/protocol/src/testing/conformance.ts',
      'apps/shared/src/i18n/en.ts',
      'apps/shared/src/runtime-contract/generated/catalog.json',
      'Cargo.toml',
    ]) {
      expect(
        paths,
        `expected scan to find ${known} | received: ${[...paths].join(', ')}`
      ).toContain(known);
    }
  });

  test('every named input exists, so the scan reads real files', () => {
    for (const input of scanCrateInputs(ROOT_DIR)) {
      const path = join(ROOT_DIR, input.path);
      expect(
        Bun.file(path).size > 0 || readdirSync(path).length > 0,
        `expected ${input.path} (read at ${input.source}:${input.line}) to exist | received: missing`
      ).toBe(true);
    }
  });
});

describe('extractCrateInputs', () => {
  const crate = 'crates/x';
  const file = 'crates/x/src/a.rs';
  const pathsOf = (text: string, at = file) =>
    extractCrateInputs(at, text, crate).map((input) => input.path);

  test('reads a bare include relative to the source file', () => {
    expect(pathsOf('const S: &str = include_str!("../../../scripts/a.sample");')).toEqual([
      'scripts/a.sample',
    ]);
  });

  test('reads a manifest-dir include relative to the crate', () => {
    const text = `include_bytes!(concat!(\n  env!("CARGO_MANIFEST_DIR"),\n  "/../../spec/a.bin"\n))`;
    expect(pathsOf(text, 'crates/x/tests/t.rs')).toEqual(['spec/a.bin']);
  });

  test('keeps the directory when a macro parameter supplies the file name', () => {
    const text = 'include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/f/", $file))';
    expect(pathsOf(text)).toEqual(['spec/f/']);
  });

  test('reads a doc-comment include, which a doctest compiles', () => {
    const text =
      '/// let t = include_str!(concat!(\n///     env!("CARGO_MANIFEST_DIR"),\n///     "/../../spec/d.json"\n/// ));';
    expect(pathsOf(text)).toEqual(['spec/d.json']);
  });

  test('reads a run-time join onto the manifest dir, with no include macro', () => {
    const text = 'Path::new(env!("CARGO_MANIFEST_DIR"))\n    .join("../../packages/p/a.ts");';
    expect(pathsOf(text)).toEqual(['packages/p/a.ts']);
  });

  test('reads a concat! manifest path used at run time', () => {
    const text = 'let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.toml");';
    expect(pathsOf(text)).toEqual(['Cargo.toml']);
  });

  test('reads a #[path] attribute relative to the source file', () => {
    const text = '#[path = "../../../shared/m.rs"]\nmod m;';
    expect(pathsOf(text, 'crates/x/tests/support/mod.rs')).toEqual(['crates/shared/m.rs']);
  });

  test('ignores a generated OUT_DIR include and unrelated ../ literals', () => {
    const text = 'include!(concat!(env!("OUT_DIR"), "/gen.rs")); let e = check("../secret");';
    expect(pathsOf(text)).toEqual([]);
  });

  test('reports the line of the read', () => {
    const [input] = extractCrateInputs(file, '\n\ninclude_str!("../../../a.txt");', crate);
    expect(input?.line).toBe(3);
  });
});

describe('discoverQualificationTests', () => {
  test('selects every api test that uses the real-binary helpers', () => {
    // An independent signal from the import walk: a file that calls one of
    // the resolver's helpers, or reads the stand-in vendor, needs the binary.
    const signal =
      /\b(resolveRustRuntimeBinary|skipWithoutRustBinary|rustRuntimeVersion)\b|MANGOSTUDIO_FAKE_CURSOR_AGENT|from '[./]+\/support\/rust-/;
    const missing = apiTestFiles()
      .filter((file) => signal.test(readFileSync(file, 'utf8')))
      .map(apiRelative)
      .filter((file) => !selected.has(file));
    expect(missing, 'Rust-backed test files real-binary-qualification would not run').toEqual([]);
  });

  test('keeps every suite the lane ran before discovery replaced its list', () => {
    const floor = [
      'tests/integration/services/rust-runtime-qualification.integration.test.ts',
      'tests/integration/services/rust-runtime-external-agents-qualification.integration.test.ts',
      'tests/integration/services/rust-filesystem-search-compat.integration.test.ts',
      'tests/integration/services/rust-snapshot-compat.integration.test.ts',
      'tests/integration/services/rust-command-compat.integration.test.ts',
      'tests/integration/services/rust-runtime-mcp-qualification.integration.test.ts',
      'tests/integration/services/rust-runtime-library-qualification.integration.test.ts',
      'tests/integration/services/rust-runtime-library-propagation.integration.test.ts',
      'tests/integration/services/rust-runtime-library-removal.integration.test.ts',
      'tests/integration/services/local-rust-runtime.integration.test.ts',
      'tests/integration/routes/rust-runtime-qualification-connect.integration.test.ts',
      'tests/integration/routes/terminal-socket.integration.test.ts',
      'tests/integration/routes/environment-entities.integration.test.ts',
      'tests/integration/services/hub-isolation-claim.integration.test.ts',
      'tests/integration/services/connect-http-runtime.integration.test.ts',
      'tests/integration/services/environment-install-execution.integration.test.ts',
      'tests/integration/modules/library/library-undo-missing-backup.integration.test.ts',
    ];
    const unitFloor = [
      'tests/unit/services/tools/read-file-tool.test.ts',
      'tests/unit/services/tools/write-file-tool.test.ts',
      'tests/unit/services/tools/list-directory-tool.test.ts',
      'tests/unit/services/tools/glob-tool.test.ts',
    ];
    for (const file of floor) expect(discovered.integration, `lost ${file}`).toContain(file);
    for (const file of unitFloor) expect(discovered.unit, `lost ${file}`).toContain(file);
  });

  test('opt-in files exist, would be discovered, and are left out', () => {
    const unfiltered = discoverQualificationTests(ROOT_DIR, []);
    const all = [...unfiltered.unit, ...unfiltered.integration];
    for (const file of OPT_IN_TESTS) {
      expect(all, `OPT_IN_TESTS entry is stale: ${file}`).toContain(file);
      expect(discovered.integration).not.toContain(file);
      expect(discovered.unit).not.toContain(file);
    }
  });

  test('unit files run on one isolated worker, integration files do not', () => {
    expect(SUITE_FLAGS.unit).toContain('--parallel=1');
    expect(SUITE_FLAGS.integration).not.toContain('--parallel=1');
    for (const file of discovered.unit) expect(file.startsWith('tests/unit/')).toBe(true);
    for (const file of discovered.integration) expect(file.startsWith('tests/unit/')).toBe(false);
  });

  describe('on a synthetic tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'rust-lanes-'));
    const write = (path: string, text: string) => {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    };
    afterAll(() => rmSync(root, { force: true, recursive: true }));

    write(RUST_BINARY_RESOLVER, 'export const resolve = () => 1;\n');
    write(
      'apps/api/tests/support/rust-client.ts',
      "import { resolve } from './rust-runtime-binary';\n"
    );
    write('apps/api/tests/support/cycle-a.ts', "import './cycle-b';\n");
    write('apps/api/tests/support/cycle-b.ts', "import './cycle-a';\n");
    write(
      'apps/api/tests/integration/direct.integration.test.ts',
      "import { resolve } from '../support/rust-runtime-binary';\n"
    );
    write(
      'apps/api/tests/integration/nested/transitive.integration.test.ts',
      "import { client } from '../../support/rust-client.ts';\n"
    );
    write(
      'apps/api/tests/unit/dynamic.test.ts',
      "const m = await import('../support/rust-client');\n"
    );
    write('apps/api/tests/unit/plain.test.ts', "import '../support/cycle-a';\n");
    write(
      'apps/api/tests/integration/other.integration.test.ts',
      "import { x } from 'bun:test';\n"
    );

    test('follows direct, transitive, and dynamic imports and survives cycles', () => {
      expect(discoverQualificationTests(root)).toEqual({
        unit: ['tests/unit/dynamic.test.ts'],
        integration: [
          'tests/integration/direct.integration.test.ts',
          'tests/integration/nested/transitive.integration.test.ts',
        ],
      });
    });
  });

  describe('on a tree whose cycle reaches the resolver through a third module', () => {
    // a -> b, b -> a, a -> c, c -> resolver. Searching from a visits b while a
    // is still open, so b's own answer is incomplete there; a later test that
    // imports only b must still be selected.
    const root = mkdtempSync(join(tmpdir(), 'rust-lanes-cycle-'));
    const write = (path: string, text: string) => {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    };
    afterAll(() => rmSync(root, { force: true, recursive: true }));

    write(RUST_BINARY_RESOLVER, 'export const resolve = () => 1;\n');
    write('apps/api/tests/support/a.ts', "import './b';\nimport './c';\n");
    write('apps/api/tests/support/b.ts', "import './a';\n");
    write('apps/api/tests/support/c.ts', "import './rust-runtime-binary';\n");
    write('apps/api/tests/integration/a-first.integration.test.ts', "import '../support/a';\n");
    write('apps/api/tests/integration/b-second.integration.test.ts', "import '../support/b';\n");

    test('selects a test that enters the cycle at the module searched mid-cycle', () => {
      expect(discoverQualificationTests(root).integration).toEqual([
        'tests/integration/a-first.integration.test.ts',
        'tests/integration/b-second.integration.test.ts',
      ]);
    });
  });
});
