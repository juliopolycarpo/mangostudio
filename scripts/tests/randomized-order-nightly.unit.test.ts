import { describe, expect, test } from 'bun:test';

import { TEST_LANES } from '../lib/test-lanes';
import { readText } from './support/read-text';
import { extractStepBlocksAtIndent } from './support/workflow-blocks';

// The nightly is the only place a cross-file state leak can be detected: the
// merge gate runs one partition per commit and reports green as long as that
// partition happens to be a safe order. These tests pin the two properties that
// decide whether it can detect anything at all — that a lane matching the merge
// gate's unisolated invocation exists, and that it is not silently given the
// `--parallel=1` every other lane takes (which implies `--isolate`, and a fresh
// global per file is exactly what hides the class).

const WORKFLOW_PATH = '.github/workflows/randomized-order-nightly.yml';

/** Read once: the workflow is a fixture, not a per-test input. */
const WORKFLOW = readText(WORKFLOW_PATH);

/** A literal `${{`, assembled so Biome does not read it as a template hole. */
const EXPR = `$${'{{'}`;

// The `include:` list body, bounded at the next key indented 4 (`env:`). Without
// the bound the last entry runs to EOF and every assertion about it is really an
// assertion about the rest of the file.
const MATRIX_INCLUDE = /\n {8}include:\n([\s\S]*?)(?=\n {4}\S)/.exec(WORKFLOW)?.[1] ?? '';

/**
 * The matrix entries, split by the shared workflow-block helper and stripped of
 * comments. Comments go because they carry prose about the *other* lanes' flags
 * — the entry above `api-integration` explains `--parallel=1` — so "this lane's
 * entry does not mention `--parallel`" has to read the keys, not whichever
 * paragraph happens to sit above the next `- lane:`.
 * // Usage: matrixEntries().find((entry) => entry.includes('lane: api'));
 */
const matrixEntries = (): string[] =>
  extractStepBlocksAtIndent(MATRIX_INCLUDE, 10).map((entry) =>
    entry
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
  );

/** The matrix entry for one `lane:` value. // Usage: matrixEntry('api-integration'); */
const matrixEntry = (lane: string): string => {
  // Matched on the entry's own first line, so `api` cannot claim
  // `api-integration`'s block by prefix.
  const entry = matrixEntries().find((block) => block.split('\n')[0].trim() === `- lane: ${lane}`);
  if (!entry) throw new Error(`No '${lane}' entry in the ${WORKFLOW_PATH} matrix.`);
  return entry;
};

describe('randomized order nightly workflow', () => {
  test('randomizes every lane and stays off the merge gate', () => {
    expect(WORKFLOW).toContain('--randomize');
    expect(WORKFLOW).toContain('--seed=');
    // A diagnostic, not a gate. Making it block merges teaches everyone to
    // re-run CI, and that habit outlasts the fix it was meant to force.
    expect(WORKFLOW).not.toContain('pull_request');
    expect(WORKFLOW).toContain('permissions:\n  contents: read');
    // One red lane must not cancel the others' evidence — and one lane is
    // expected to stay red while a known defect is open.
    expect(WORKFLOW).toContain('fail-fast: false');
  });

  // Asserted against the entries that run the *whole* workspace (`path: ""`),
  // not the workflow text: two entries now share `workspace: api`, so a bare
  // substring check would let the integration-only entry stand in for the
  // whole-workspace one and the `api` lane could be deleted unnoticed.
  test('covers every workspace that owns a Bun test lane', () => {
    const workspaces = new Set(
      TEST_LANES.filter((lane) => lane.workspace !== 'root' && lane.workspace !== 'frontend').map(
        (lane) => lane.workspace
      )
    );
    const wholeSuite = matrixEntries()
      .filter((entry) => entry.includes('path: ""'))
      .map((entry) => /workspace: (\S+)/.exec(entry)?.[1] ?? '');

    for (const workspace of workspaces) {
      expect(wholeSuite).toContain(workspace);
    }
  });

  // The load-bearing one. `api-integration` is the merge gate's only unisolated
  // lane (see test-lanes.ts), so it is the only lane where one file's leftover
  // in-memory database rows, `mock.module` registrations, or memoized
  // `getAuth()` can reach the next file. Randomizing it under `--parallel=1`
  // would run it in a mode the merge gate never uses and report green on a
  // hazard it never exercised.
  test('runs the merge gate unisolated lane without isolation', () => {
    const entry = matrixEntry('api-integration');

    expect(entry).toContain('workspace: api');
    expect(entry).toContain('path: tests/integration');
    expect(entry).toContain('isolation: ""');
    expect(entry).not.toContain('--parallel');
    expect(entry).not.toContain('--isolate');
  });

  test('keeps the whole-workspace lanes isolated', () => {
    for (const lane of ['api', 'shared', 'runtime']) {
      expect(matrixEntry(lane)).toContain('isolation: "--parallel=1"');
    }
  });

  test('names artifacts by lane, so two lanes of one workspace cannot collide', () => {
    // Two entries share `workspace: api`; keying the upload on the workspace
    // would make the second upload fail or overwrite the first, and the log is
    // the entire finding.
    expect(WORKFLOW).toContain(`name: randomized-order-${EXPR} matrix.lane }}-seed-`);
  });
});
