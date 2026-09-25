/**
 * The hub talks to a runtime over the wire, not through an import.
 *
 * Every contract the two share — method shapes, event topics, error kinds,
 * numeric caps, the helpers both machines run — lives in
 * `@mangostudio/shared`. What is left of the TypeScript runtime package in
 * this workspace is the in-process wiring for Local: constructing a host
 * definition and handing it a port, in one file, which is the seam that
 * disappears when Local becomes a spawned sibling. The workspace's tests reach
 * it through none at all: fakes are served by `tests/support/fake-runtime-host.ts`
 * and real runtime behaviour comes from the compiled Rust binary.
 *
 * The package name is assembled from parts below so this file, which has to
 * name it, is not itself a match for a repository-wide search for importers.
 *
 * Asserted by walking the real source tree rather than trusted to review,
 * because the failure is silent and cheap to reintroduce: an import added here
 * compiles, passes, and is only noticed when the runtime it reaches into is no
 * longer written in TypeScript. Precedent: `tests/unit/lib/hidden-window.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../../../../..');
const API_SRC = join(REPO_ROOT, 'apps/api/src');
const API_TESTS = join(REPO_ROOT, 'apps/api/tests');

/** The TypeScript runtime package, spelled so this file does not import-match itself. */
const RUNTIME_PACKAGE = ['@mangostudio', 'runtime'].join('/');

/** The one file allowed to reach the runtime as a module, repo-relative. */
const ALLOWED = 'apps/api/src/services/runtime-client/connect-in-process-runtime.ts';

const RUNTIME_SPECIFIER = new RegExp(
  `(?:from|import)\\s*\\(?\\s*['"]${RUNTIME_PACKAGE}(?:/[^'"]*)?['"]`
);

/** The in-process seam's module, as a test would import it. */
const IN_PROCESS_SEAM_SPECIFIER = /['"][./]*(?:[^'"]*\/)?connect-in-process-runtime['"]/;

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => join(directory, entry))
    .filter((path) => statSync(path).isFile());
}

describe('the hub imports the runtime module in exactly one place', () => {
  const files = sourceFilesUnder(API_SRC);

  it('scans a set of files that is neither empty nor accidentally tiny', () => {
    // Guards the walk itself: a broken glob would make the check below pass by
    // looking at nothing at all.
    expect(files.length).toBeGreaterThan(50);
  });

  it('finds the runtime package only in the in-process seam', () => {
    const importers = files
      .filter((file) => RUNTIME_SPECIFIER.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(REPO_ROOT.length + 1).replaceAll('\\', '/'))
      .sort();

    expect(importers).toEqual([ALLOWED]);
  });

  it('still recognises the import shape it is guarding', () => {
    // Guards the matcher: a regex that stopped matching would also make the
    // check above pass, by finding nothing to complain about.
    expect(
      RUNTIME_SPECIFIER.test(`import { createRuntimeSession } from '${RUNTIME_PACKAGE}';`)
    ).toBe(true);
    expect(RUNTIME_SPECIFIER.test(`const mod = await import('${RUNTIME_PACKAGE}');`)).toBe(true);
    expect(
      RUNTIME_SPECIFIER.test(
        "import { RUNTIME_CONTRACT } from '@mangostudio/shared/runtime-contract';"
      )
    ).toBe(false);
  });
});

describe('the hub tests import no TypeScript runtime', () => {
  const files = sourceFilesUnder(API_TESTS);

  it('scans a set of files that is neither empty nor accidentally tiny', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('finds no test file importing the runtime package', () => {
    const importers = files
      .filter((file) => RUNTIME_SPECIFIER.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(REPO_ROOT.length + 1).replaceAll('\\', '/'));

    expect(importers).toEqual([]);
  });

  it('finds no test file importing the in-process seam', () => {
    // The seam builds a TypeScript runtime host; a test reaching it would still
    // depend on that runtime through production code.
    const importers = files
      .filter((file) => IN_PROCESS_SEAM_SPECIFIER.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(REPO_ROOT.length + 1).replaceAll('\\', '/'));

    expect(importers).toEqual([]);
  });

  it('recognises a relative import of the seam', () => {
    // Assembled, so this file does not match its own scan.
    const seam = ['connect', 'in', 'process', 'runtime'].join('-');
    expect(
      IN_PROCESS_SEAM_SPECIFIER.test(
        `import { connectInProcessRuntime } from '../../../src/services/runtime-client/${seam}';`
      )
    ).toBe(true);
    expect(IN_PROCESS_SEAM_SPECIFIER.test("const ALLOWED = 'apps/api/src/x.ts';")).toBe(false);
  });
});
