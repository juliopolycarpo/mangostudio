import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeCoverageSummaries, readJsonCoverageSummary } from './coverage-summary';
import type { CoverageSummary } from './parse-lcov';

const tempDirs: string[] = [];

const makeSummary = (linesCovered: number): CoverageSummary => ({
  lines: { total: 100, covered: linesCovered, pct: linesCovered },
  statements: { total: 100, covered: linesCovered, pct: linesCovered },
  functions: { total: 10, covered: 8, pct: 80 },
  branches: { total: 20, covered: 10, pct: 50 },
});

const writeJsonSummary = async (summary: CoverageSummary): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mango-coverage-summary-'));
  tempDirs.push(dir);
  const path = join(dir, 'coverage-summary.json');
  await writeFile(path, JSON.stringify({ total: summary }), 'utf8');
  return path;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('readJsonCoverageSummary', () => {
  it('reads the total bucket from a Vitest json-summary report', async () => {
    const path = await writeJsonSummary(makeSummary(82));

    const summary = await readJsonCoverageSummary(path);

    expect(summary.lines.pct).toBe(82);
    expect(summary.branches?.covered).toBe(10);
  });
});

describe('mergeCoverageSummaries', () => {
  it('combines line and function totals across coverage sources', () => {
    const summary = mergeCoverageSummaries([
      makeSummary(80),
      {
        lines: { total: 50, covered: 45, pct: 90 },
        statements: null,
        functions: { total: 5, covered: 5, pct: 100 },
        branches: null,
      },
    ]);

    expect(summary.lines).toEqual({ total: 150, covered: 125, pct: 83.33 });
    expect(summary.functions).toEqual({ total: 15, covered: 13, pct: 86.67 });
    expect(summary.statements).toEqual({ total: 100, covered: 80, pct: 80 });
    expect(summary.branches).toEqual({ total: 20, covered: 10, pct: 50 });
  });

  it('reports a zero denominator as n/a, never as 100%', () => {
    const empty: CoverageSummary = {
      lines: { total: 0, covered: 0, pct: null },
      statements: null,
      functions: { total: 0, covered: 0, pct: null },
      branches: { total: 0, covered: 0, pct: null },
    };

    const summary = mergeCoverageSummaries([empty]);

    expect(summary.lines).toEqual({ total: 0, covered: 0, pct: null });
    expect(summary.branches).toEqual({ total: 0, covered: 0, pct: null });
  });
});
