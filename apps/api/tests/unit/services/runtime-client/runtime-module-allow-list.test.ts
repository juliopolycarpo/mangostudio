/**
 * The hub talks to a runtime over the wire, not through an import.
 *
 * Every contract the two share — method shapes, event topics, error kinds,
 * numeric caps, the helpers both machines run — lives in
 * `@mangostudio/shared`. What is left of `@mangostudio/runtime` in this
 * workspace is the in-process wiring for Local: constructing a host definition
 * and handing it a port, in one file, which is the seam that disappears when
 * Local becomes a spawned sibling.
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

/** The one file allowed to reach the runtime as a module, repo-relative. */
const ALLOWED = 'apps/api/src/services/runtime-client/connect-in-process-runtime.ts';

const RUNTIME_SPECIFIER = /(?:from|import)\s*\(?\s*['"]@mangostudio\/runtime(?:\/[^'"]*)?['"]/;

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

  it('finds @mangostudio/runtime only in the in-process seam', () => {
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
      RUNTIME_SPECIFIER.test("import { createRuntimeSession } from '@mangostudio/runtime';")
    ).toBe(true);
    expect(RUNTIME_SPECIFIER.test("const mod = await import('@mangostudio/runtime');")).toBe(true);
    expect(
      RUNTIME_SPECIFIER.test(
        "import { RUNTIME_CONTRACT } from '@mangostudio/shared/runtime-contract';"
      )
    ).toBe(false);
  });
});
