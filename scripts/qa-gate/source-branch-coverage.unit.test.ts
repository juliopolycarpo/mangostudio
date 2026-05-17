import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSourceBranchCoverageSummary } from './source-branch-coverage';

const tempDirs: string[] = [];

const makeWorkspace = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mango-source-branches-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'src'), { recursive: true });
  return dir;
};

const writeFixture = async (
  workspaceDir: string,
  sourceText: string,
  lcovText: string
): Promise<string> => {
  const sourcePath = join(workspaceDir, 'src/example.ts');
  const lcovPath = join(workspaceDir, 'coverage/lcov.info');
  await mkdir(join(workspaceDir, 'coverage'), { recursive: true });
  await Promise.all([
    writeFile(sourcePath, sourceText, 'utf8'),
    writeFile(lcovPath, lcovText, 'utf8'),
  ]);
  return lcovPath;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readSourceBranchCoverageSummary', () => {
  it('infers both paths for an if statement without an explicit else', async () => {
    const workspaceDir = await makeWorkspace();
    const lcovPath = await writeFixture(
      workspaceDir,
      [
        'export function label(enabled: boolean): string {',
        '  if (enabled) {',
        '    return "enabled";',
        '  }',
        '  return "disabled";',
        '}',
      ].join('\n'),
      ['SF:src/example.ts', 'DA:2,2', 'DA:3,1', 'DA:5,1', 'end_of_record'].join('\n')
    );

    const summary = await readSourceBranchCoverageSummary(lcovPath);

    expect(summary).toEqual({ total: 2, covered: 2, pct: 100 });
  });

  it('counts uncovered switch clauses and conditional branches', async () => {
    const workspaceDir = await makeWorkspace();
    const lcovPath = await writeFixture(
      workspaceDir,
      [
        'export function label(value: "a" | "b" | "c", fallback: boolean): string {',
        '  switch (value) {',
        '    case "a":',
        '      return fallback',
        '        ? "fallback"',
        '        : "alpha";',
        '    case "b":',
        '      return "beta";',
        '    default:',
        '      return "other";',
        '  }',
        '}',
      ].join('\n'),
      [
        'SF:src/example.ts',
        'DA:3,1',
        'DA:4,1',
        'DA:5,1',
        'DA:6,0',
        'DA:7,0',
        'DA:8,0',
        'end_of_record',
      ].join('\n')
    );

    const summary = await readSourceBranchCoverageSummary(lcovPath);

    expect(summary).toEqual({ total: 5, covered: 2, pct: 40 });
  });
});
