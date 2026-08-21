import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSourceBranchCoverageSummary } from './source-branch-coverage';

const tempDirs: string[] = [];

interface RepoFixture {
  readonly lcovPath: string;
  readonly workspaceDir: string;
}

// Mirrors the CI layout: LCOV under .mango/artifacts, sources under apps/api.
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mango-source-branches-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'apps/api/src'), { recursive: true });
  await mkdir(join(dir, '.mango/artifacts/coverage/api'), { recursive: true });
  return dir;
};

const writeFixture = async (sourceText: string | null, lcovText: string): Promise<RepoFixture> => {
  const repoDir = await makeRepo();
  const lcovPath = join(repoDir, '.mango/artifacts/coverage/api/lcov.info');
  const writes = [writeFile(lcovPath, lcovText, 'utf8')];
  if (sourceText !== null) {
    writes.push(writeFile(join(repoDir, 'apps/api/src/example.ts'), sourceText, 'utf8'));
  }
  await Promise.all(writes);
  return { lcovPath, workspaceDir: join(repoDir, 'apps/api') };
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readSourceBranchCoverageSummary', () => {
  it('infers both paths for an if statement without an explicit else', async () => {
    const { lcovPath, workspaceDir } = await writeFixture(
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

    const summary = await readSourceBranchCoverageSummary(lcovPath, workspaceDir);

    expect(summary).toEqual({ total: 2, covered: 2, pct: 100 });
  });

  it('counts uncovered switch clauses and conditional branches', async () => {
    const { lcovPath, workspaceDir } = await writeFixture(
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

    const summary = await readSourceBranchCoverageSummary(lcovPath, workspaceDir);

    expect(summary).toEqual({ total: 5, covered: 2, pct: 40 });
  });

  it('resolves absolute SF records without applying the base directory', async () => {
    const { lcovPath, workspaceDir } = await writeFixture(
      ['export const flag = process.env.CI ? "ci" : "local";'].join('\n'),
      ''
    );
    await writeFile(
      lcovPath,
      [`SF:${join(workspaceDir, 'src/example.ts')}`, 'DA:1,1', 'end_of_record'].join('\n'),
      'utf8'
    );

    const summary = await readSourceBranchCoverageSummary(lcovPath, workspaceDir);

    expect(summary.total).toBe(2);
  });

  it('reports n/a instead of 100% when covered source has no branch constructs', async () => {
    const { lcovPath, workspaceDir } = await writeFixture(
      ['export const NAME = "mango";'].join('\n'),
      ['SF:src/example.ts', 'DA:1,1', 'end_of_record'].join('\n')
    );

    const summary = await readSourceBranchCoverageSummary(lcovPath, workspaceDir);

    expect(summary).toEqual({ total: 0, covered: 0, pct: null });
  });

  it('fails loudly when a referenced source file does not exist', async () => {
    const { lcovPath, workspaceDir } = await writeFixture(
      null,
      ['SF:src/example.ts', 'DA:1,1', 'end_of_record'].join('\n')
    );

    await expect(readSourceBranchCoverageSummary(lcovPath, workspaceDir)).rejects.toThrow(
      'src/example.ts'
    );
  });
});
