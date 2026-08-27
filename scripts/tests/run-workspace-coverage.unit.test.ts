import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CoverageLane,
  lanesForWorkspace,
  runWorkspaceCoverage,
  type WorkspaceCoverageOptions,
} from '../ci/run-workspace-coverage';

const temps: string[] = [];

const makeTemp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mango-workspace-coverage-'));
  temps.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const STAGED = 'coverage/staged/lcov.info';

// Stands in for `bun test --coverage`: writes an LCOV slice for one source file
// (or nothing, for a lane whose slice held no file from this workspace) and
// exits with the code the fixture manifest asked for.
const LANE_FIXTURE = `
const [, , slicePath, exitCode, sourceName] = process.argv;
if (sourceName !== 'none') {
  const body = ['TN:', 'SF:' + sourceName, 'FNF:1', 'FNH:1', 'DA:1,1', 'DA:2,0', 'end_of_record'];
  await Bun.write(slicePath, body.join('\\n') + '\\n');
}
process.exit(Number(exitCode));
`;

interface LaneSpec {
  readonly id: string;
  /** Source file the lane's slice covers, or 'none' to write no slice at all. */
  readonly source: string;
  readonly exitCode: number;
}

/**
 * Build a workspace whose lanes are the given specs: a manifest with one script
 * per lane, all of them running the fixture above.
 */
const workspaceWith = async (
  specs: readonly LaneSpec[]
): Promise<{ dir: string; options: WorkspaceCoverageOptions }> => {
  const dir = await makeTemp();
  await Bun.write(join(dir, 'lane.ts'), LANE_FIXTURE);

  const lanes: CoverageLane[] = specs.map((spec) => ({
    id: spec.id,
    coverageScript: spec.id,
    lcovPath: `coverage/${spec.id}/lcov.info`,
  }));
  const scripts = Object.fromEntries(
    specs.map((spec, index) => [
      spec.id,
      `bun ./lane.ts ${lanes[index]?.lcovPath} ${spec.exitCode} ${spec.source}`,
    ])
  );
  await Bun.write(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts }));

  return { dir, options: { lanes, cwd: dir, stagedLcovPath: STAGED, rootDir: dir } };
};

const stagedText = async (dir: string): Promise<string> => {
  const file = Bun.file(join(dir, STAGED));
  return (await file.exists()) ? file.text() : '';
};

describe('runWorkspaceCoverage', () => {
  it('runs every lane and merges their slices into the staged file', async () => {
    const { dir, options } = await workspaceWith([
      { id: 'unit', source: 'a.ts', exitCode: 0 },
      { id: 'integration', source: 'b.ts', exitCode: 0 },
    ]);

    const result = await runWorkspaceCoverage(options);

    expect(result).toMatchObject({ exitCode: 0, mergedSlices: 2 });
    const staged = await stagedText(dir);
    expect(staged).toContain('SF:a.ts');
    expect(staged).toContain('SF:b.ts');
  });

  // The regression this script exists for. Under the `&&` chain this replaced,
  // a failing first lane skipped the second lane and the merge, so the red
  // shard uploaded neither the second lane's JUnit nor any api LCOV — and a
  // failure shared across the shards killed the merge job on a missing input
  // instead of reporting the test failures.
  it('keeps running lanes and still merges after the first one fails', async () => {
    const { dir, options } = await workspaceWith([
      { id: 'unit', source: 'a.ts', exitCode: 1 },
      { id: 'integration', source: 'b.ts', exitCode: 0 },
    ]);

    const result = await runWorkspaceCoverage(options);

    expect(result.exitCode).toBe(1);
    expect(result.lanes.map((lane) => lane.id)).toEqual(['unit', 'integration']);
    expect(result.mergedSlices).toBe(2);
    const staged = await stagedText(dir);
    expect(staged).toContain('SF:a.ts');
    expect(staged).toContain('SF:b.ts');
  });

  // A failing lane is the more specific fact and must win the exit code, but
  // the first failure is the one to report — the second lane's code must not
  // overwrite it, and a green second lane must not clear it.
  it('reports the first failing lane, not the last', async () => {
    const { options } = await workspaceWith([
      { id: 'unit', source: 'a.ts', exitCode: 3 },
      { id: 'integration', source: 'b.ts', exitCode: 7 },
    ]);

    expect((await runWorkspaceCoverage(options)).exitCode).toBe(3);
  });

  // `mergeLcovFiles` throws on an empty input set, which is right for the shard
  // merge (it knows how many shards ran) and wrong here: a shard whose slice
  // held no file from this workspace legitimately produces nothing, and must
  // exit 0 with nothing to contribute rather than failing its whole task.
  it('tolerates a run where no lane produced a slice', async () => {
    const { dir, options } = await workspaceWith([
      { id: 'unit', source: 'none', exitCode: 0 },
      { id: 'integration', source: 'none', exitCode: 0 },
    ]);
    // A staged file left by an earlier run must not survive as this run's
    // coverage either.
    await Bun.write(join(dir, STAGED), 'TN:\nSF:stale.ts\nFNF:0\nFNH:0\nend_of_record\n');

    const result = await runWorkspaceCoverage(options);

    expect(result).toMatchObject({ exitCode: 0, mergedSlices: 0 });
    expect(await stagedText(dir)).toBe('');
  });

  // Whether a slice file exists is the entire merge-input decision, so a slice
  // an earlier local run left behind would otherwise be merged in as this run's
  // coverage — inflating the workspace's figures from a file nothing ran.
  it('drops a stale slice a previous run left behind', async () => {
    const { dir, options } = await workspaceWith([
      { id: 'unit', source: 'none', exitCode: 0 },
      { id: 'integration', source: 'b.ts', exitCode: 0 },
    ]);
    await Bun.write(
      join(dir, 'coverage/unit/lcov.info'),
      'TN:\nSF:stale.ts\nFNF:1\nFNH:1\nDA:1,1\nend_of_record\n'
    );

    const result = await runWorkspaceCoverage(options);

    expect(result).toMatchObject({ exitCode: 0, mergedSlices: 1 });
    const staged = await stagedText(dir);
    expect(staged).not.toContain('stale.ts');
    expect(staged).toContain('SF:b.ts');
  });

  // A lane whose script does not exist exits non-zero through `bun run` rather
  // than throwing, but either way it must be recorded as a failed lane and the
  // lanes after it must still run.
  it('records a lane whose script is missing without skipping the rest', async () => {
    const { dir, options } = await workspaceWith([
      { id: 'integration', source: 'b.ts', exitCode: 0 },
    ]);
    const lanes: CoverageLane[] = [
      { id: 'unit', coverageScript: 'no-such-script', lcovPath: 'coverage/unit/lcov.info' },
      ...options.lanes,
    ];

    const result = await runWorkspaceCoverage({ ...options, lanes });

    expect(result.exitCode).not.toBe(0);
    expect(result.lanes.map((lane) => lane.id)).toEqual(['unit', 'integration']);
    expect(result.mergedSlices).toBe(1);
    expect(await stagedText(dir)).toContain('SF:b.ts');
  });
});

describe('lanesForWorkspace', () => {
  it('returns the api workspace lanes with distinct slices', () => {
    const lanes = lanesForWorkspace('api');
    expect(lanes.map((lane) => lane.id)).toEqual(['api-unit', 'api-integration']);
    expect(new Set(lanes.map((lane) => lane.lcovPath)).size).toBe(2);
  });

  // The orchestrator merges by slice path, so a lane without one has no input
  // to contribute and would silently drop out of the merge. Fail loudly at the
  // lookup instead — a single-lane workspace writes the staged file directly
  // and does not come through here at all.
  it('rejects a workspace whose lanes declare no slice', () => {
    expect(() => lanesForWorkspace('shared')).toThrow(/lcovPath/);
  });
});
