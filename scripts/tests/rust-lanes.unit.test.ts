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
    ['Cargo.lock', true, true],
    ['apps/shared/src/runtime-home/schemas.ts', true, true],
    // #1099: hub modules the qualification suites exercise but no list named.
    ['apps/api/src/services/tools/arg-parsing.ts', false, true],
    ['apps/api/src/modules/environments/application/environment-service.ts', false, true],
    ['apps/api/tests/support/rust-runtime-binary.ts', false, true],
    ['apps/shared/src/i18n/en.ts', false, true],
    ['scripts/lib/rust-lanes.ts', false, true],
    ['apps/frontend/src/main.tsx', false, false],
    ['docs/reference/releasing.md', false, false],
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
});
