/**
 * The hub talks to a runtime over the wire, not through an import.
 *
 * Every contract the two share — method shapes, event topics, error kinds,
 * numeric caps, the helpers both machines run — lives in
 * `@mangostudio/shared`. The TypeScript runtime package, and the in-process
 * seam Local used before it became a spawned Rust runtime, are gone, so no
 * file in this workspace may name either. Fakes are served by
 * `tests/support/fake-runtime-host.ts` and real runtime behaviour comes from
 * the compiled Rust binary.
 *
 * The package name is assembled from parts below so this file, which has to
 * name it, is not itself a match for a repository-wide search for importers.
 *
 * Asserted by walking the real source tree rather than trusted to review,
 * because the failure is cheap to reintroduce: an import added here would
 * fail only at install time, far from the change that caused it.
 * Precedent: `tests/unit/lib/hidden-window.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../../../../..');
const API_SRC = join(REPO_ROOT, 'apps/api/src');
const API_TESTS = join(REPO_ROOT, 'apps/api/tests');

/** The TypeScript runtime package, spelled so this file does not import-match itself. */
const RUNTIME_PACKAGE = ['@mangostudio', 'runtime'].join('/');

const RUNTIME_SPECIFIER = new RegExp(
  `(?:from|import)\\s*\\(?\\s*['"]${RUNTIME_PACKAGE}(?:/[^'"]*)?['"]`
);

/** The deleted in-process seam's module, as a file would import it. */
const IN_PROCESS_SEAM_SPECIFIER = /['"][./]*(?:[^'"]*\/)?connect-in-process-runtime['"]/;

/**
 * A quoted string naming a file in the TypeScript runtime's source tree, the
 * way a test spawns it by path (`join(dir, '../../../../runtime/src/cli.ts')`).
 * `mangostudio-runtime/src/` (the Rust crate) is not a match.
 */
const RUNTIME_SOURCE_LITERAL = /(['"`])[^'"`\n]*(?<![\w-])runtime\/src\/[^'"`\n]*\1/;

/** Lines that are code rather than comments, where a path literal would be used. */
function codeLines(text: string): string[] {
  return text.split('\n').filter((line) => {
    const trimmed = line.trimStart();
    return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
  });
}

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .map((entry) => join(directory, entry))
    .filter((path) => statSync(path).isFile());
}

describe('the hub source imports no TypeScript runtime', () => {
  const files = sourceFilesUnder(API_SRC);

  it('scans a set of files that is neither empty nor accidentally tiny', () => {
    // Guards the walk itself: a broken glob would make the check below pass by
    // looking at nothing at all.
    expect(files.length).toBeGreaterThan(50);
  });

  it('finds no source file importing the runtime package', () => {
    const importers = files
      .filter((file) => RUNTIME_SPECIFIER.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(REPO_ROOT.length + 1).replaceAll('\\', '/'));

    expect(importers).toEqual([]);
  });

  it('finds no source file importing the in-process seam', () => {
    const importers = files
      .filter((file) => IN_PROCESS_SEAM_SPECIFIER.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(REPO_ROOT.length + 1).replaceAll('\\', '/'));

    expect(importers).toEqual([]);
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

  // Local and stdio launch the Rust binary, and there is no Bun fallback left
  // to point a test at the TypeScript runtime's entry.
  it('finds no test file that spawns the TypeScript runtime by its source path', () => {
    const referrers = files
      .filter((file) =>
        codeLines(readFileSync(file, 'utf8')).some((line) => RUNTIME_SOURCE_LITERAL.test(line))
      )
      .map((file) => file.slice(REPO_ROOT.length + 1).replaceAll('\\', '/'))
      .sort();

    expect(referrers).toEqual([]);
  });

  it('recognises a runtime source path literal and ignores the Rust crate and comments', () => {
    const tree = ['runtime', 'src'].join('/');
    expect(RUNTIME_SOURCE_LITERAL.test(`join(dir, '../../../../${tree}/cli.ts')`)).toBe(true);
    expect(RUNTIME_SOURCE_LITERAL.test(`'crates/mangostudio-${tree}/health.rs'`)).toBe(false);
    expect(codeLines(` * \`apps/${tree}/services/snapshot.ts\` capture`)).toEqual([]);
  });
});
