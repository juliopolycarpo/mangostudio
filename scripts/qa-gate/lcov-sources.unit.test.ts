import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseLcovLineHits, readCoveredSources } from './lcov-sources';

const tempDirs: string[] = [];

const makeWorkspace = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'mango-lcov-sources-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'src'), { recursive: true });
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('parseLcovLineHits', () => {
  it('records malformed SF and DA lines without corrupting parsed hits', () => {
    const result = parseLcovLineHits(
      ['SF:src/a.ts', 'DA:1,2', 'DA:oops', 'end_of_record', 'SF:', 'DA:2,1', 'end_of_record'].join(
        '\n'
      ),
      '/workspace'
    );

    expect(result.recordCount).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.sourcePath).toBe('/workspace/src/a.ts');
    expect(result.files[0]?.lineHits.get(1)).toBe(2);
    expect(result.malformedRecords).toEqual(['DA:oops', 'SF:']);
  });

  it('returns no files and no records for empty LCOV text', () => {
    const result = parseLcovLineHits('', '/workspace');

    expect(result).toEqual({ files: [], recordCount: 0, malformedRecords: [] });
  });
});

describe('readCoveredSources', () => {
  it('lists missing sources as workspace-relative paths, bounded to five', async () => {
    const dir = await makeWorkspace();
    const lcovPath = join(dir, 'lcov.info');
    const records = Array.from({ length: 7 }, (_, i) =>
      [`SF:src/missing-${i}.ts`, 'DA:1,1', 'end_of_record'].join('\n')
    );
    await writeFile(lcovPath, records.join('\n'), 'utf8');

    await expect(readCoveredSources(lcovPath, dir)).rejects.toThrow(
      /7 source file\(s\) missing .* src\/missing-0\.ts, .* \(\+2 more\)/
    );
  });

  it('fails when records exist but none resolve to a source file', async () => {
    const dir = await makeWorkspace();
    const lcovPath = join(dir, 'lcov.info');
    await writeFile(lcovPath, ['SF:', 'DA:bogus', 'end_of_record'].join('\n'), 'utf8');

    await expect(readCoveredSources(lcovPath, dir)).rejects.toThrow(
      /2 malformed record\(s\) but none resolved/
    );
  });

  it('loads resolved sources as parsed TypeScript files', async () => {
    const dir = await makeWorkspace();
    const lcovPath = join(dir, 'lcov.info');
    await writeFile(join(dir, 'src/a.ts'), 'export const one = 1;\n', 'utf8');
    await writeFile(lcovPath, ['SF:src/a.ts', 'DA:1,1', 'end_of_record'].join('\n'), 'utf8');

    const sources = await readCoveredSources(lcovPath, dir);

    expect(sources).toHaveLength(1);
    expect(sources[0]?.sourceFile.statements).toHaveLength(1);
    expect(sources[0]?.lineHits.get(1)).toBe(1);
  });
});
