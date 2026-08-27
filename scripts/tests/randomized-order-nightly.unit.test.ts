import { describe, expect, test } from 'bun:test';

import { TEST_LANES } from '../lib/test-lanes';
import { readText } from './support/read-text';

// The nightly is the only place a cross-file state leak can be detected: the
// merge gate runs one partition per commit and reports green as long as that
// partition happens to be a safe order. These tests pin the two properties that
// decide whether it can detect anything at all — that a lane matching the merge
// gate's unisolated invocation exists, and that it is not silently given the
// `--parallel=1` every other lane takes (which implies `--isolate`, and a fresh
// global per file is exactly what hides the class).

const WORKFLOW_PATH = '.github/workflows/randomized-order-nightly.yml';

/** A literal `${{`, assembled so Biome does not read it as a template hole. */
const EXPR = `$${'{{'}`;

/** The matrix entry block for one `lane:` value, up to the next entry. */
const matrixEntry = (workflow: string, lane: string): string => {
  const match = new RegExp(
    `\\n\\s+- lane: ${lane}\\n([\\s\\S]*?)(?=\\n\\s+- lane: |\\n\\s{4}env:)`
  ).exec(workflow);
  if (!match) throw new Error(`No '${lane}' entry in the ${WORKFLOW_PATH} matrix.`);
  return match[1];
};

describe('randomized order nightly workflow', () => {
  test('randomizes every lane and stays off the merge gate', () => {
    const workflow = readText(WORKFLOW_PATH);

    expect(workflow).toContain('--randomize');
    expect(workflow).toContain('--seed=');
    // A diagnostic, not a gate. Making it block merges teaches everyone to
    // re-run CI, and that habit outlasts the fix it was meant to force.
    expect(workflow).not.toContain('pull_request');
    expect(workflow).toContain('permissions:\n  contents: read');
    // One red lane must not cancel the others' evidence — and one lane is
    // expected to stay red while a known defect is open.
    expect(workflow).toContain('fail-fast: false');
  });

  test('covers every workspace that owns a Bun test lane', () => {
    const workflow = readText(WORKFLOW_PATH);
    const workspaces = new Set(
      TEST_LANES.filter((lane) => lane.workspace !== 'root' && lane.workspace !== 'frontend').map(
        (lane) => lane.workspace
      )
    );

    for (const workspace of workspaces) {
      expect(workflow).toContain(`workspace: ${workspace}`);
    }
  });

  // The load-bearing one. `api-integration` is the merge gate's only unisolated
  // lane (see test-lanes.ts), so it is the only lane where one file's leftover
  // in-memory database rows, `mock.module` registrations, or memoized
  // `getAuth()` can reach the next file. Randomizing it under `--parallel=1`
  // would run it in a mode the merge gate never uses and report green on a
  // hazard it never exercised.
  test('runs the merge gate unisolated lane without isolation', () => {
    const workflow = readText(WORKFLOW_PATH);
    const entry = matrixEntry(workflow, 'api-integration');

    expect(entry).toContain('workspace: api');
    expect(entry).toContain('path: tests/integration');
    expect(entry).toContain('isolation: ""');
    expect(entry).not.toContain('--parallel');
    expect(entry).not.toContain('--isolate');
  });

  test('keeps the whole-workspace lanes isolated', () => {
    const workflow = readText(WORKFLOW_PATH);

    for (const lane of ['api', 'shared', 'runtime']) {
      expect(matrixEntry(workflow, lane)).toContain('isolation: "--parallel=1"');
    }
  });

  test('names artifacts by lane, so two lanes of one workspace cannot collide', () => {
    const workflow = readText(WORKFLOW_PATH);

    // Two entries share `workspace: api`; keying the upload on the workspace
    // would make the second upload fail or overwrite the first, and the log is
    // the entire finding.
    expect(workflow).toContain(`name: randomized-order-${EXPR} matrix.lane }}-seed-`);
  });
});
