import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { parseLcovSummary } from './parse-lcov';

const tempDirs: string[] = [];

const writeTempFile = async (contents: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mango-lcov-'));
  tempDirs.push(dir);
  const path = join(dir, 'lcov.info');
  await writeFile(path, contents, 'utf8');
  return path;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('parseLcovSummary', () => {
  it('summarizes line and function coverage across LCOV records', async () => {
    const path = await writeTempFile(`TN:
SF:apps/api/src/a.ts
LF:10
LH:8
FNF:4
FNH:3
end_of_record
SF:apps/api/src/b.ts
LF:5
LH:5
FNF:1
FNH:1
end_of_record
`);

    const summary = await parseLcovSummary(path);

    expect(summary.lines).toEqual({ total: 15, covered: 13, pct: 86.67 });
    expect(summary.functions).toEqual({ total: 5, covered: 4, pct: 80 });
    expect(summary.statements).toBeNull();
    expect(summary.branches).toBeNull();
  });

  it('reports branch coverage when LCOV branch totals exist', async () => {
    const path = await writeTempFile(`SF:apps/api/src/a.ts
LF:1
LH:1
FNF:0
FNH:0
BRF:4
BRH:2
end_of_record
`);

    const summary = await parseLcovSummary(path);

    expect(summary.branches).toEqual({ total: 4, covered: 2, pct: 50 });
  });
});
