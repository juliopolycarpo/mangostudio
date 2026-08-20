import { describe, expect, it } from 'bun:test';

import { formatLcov, mergeLcovRecords, parseLcovRecords } from './merge-lcov-shards';
import { parseLcovSummary } from './parse-lcov';

const record = (
  sourcePath: string,
  functions: [found: number, hit: number],
  lines: ReadonlyArray<[line: number, hits: number]>
): string =>
  [
    'TN:',
    `SF:${sourcePath}`,
    `FNF:${functions[0]}`,
    `FNH:${functions[1]}`,
    ...lines.map(([line, hits]) => `DA:${line},${hits}`),
    `LF:${lines.length}`,
    `LH:${lines.filter(([, hits]) => hits > 0).length}`,
    'end_of_record',
  ].join('\n');

const summarize = async (lcov: string) => {
  const path = `${import.meta.dir}/../../.mango/artifacts/tmp-merge-${Bun.randomUUIDv7()}.lcov`;
  await Bun.write(path, lcov);
  try {
    return await parseLcovSummary(path);
  } finally {
    await Bun.file(path).delete();
  }
};

describe('parseLcovRecords', () => {
  it('reads the SF/FNF/FNH/DA subset Bun emits', () => {
    const [parsed] = parseLcovRecords(
      record(
        'src/a.ts',
        [2, 1],
        [
          [1, 3],
          [2, 0],
        ]
      )
    );
    expect(parsed.sourcePath).toBe('src/a.ts');
    expect(parsed.functionsFound).toBe(2);
    expect(parsed.functionsHit).toBe(1);
    expect([...parsed.lineHits]).toEqual([
      [1, 3],
      [2, 0],
    ]);
  });

  it('closes a record at the next SF even without end_of_record', () => {
    const truncated = 'SF:src/a.ts\nDA:1,1\nSF:src/b.ts\nDA:2,2\n';
    expect(parseLcovRecords(truncated).map((entry) => entry.sourcePath)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('ignores lines before the first SF record', () => {
    expect(parseLcovRecords('TN:\nDA:1,1\n')).toEqual([]);
  });
});

describe('mergeLcovRecords', () => {
  // The whole reason this module exists. Bun reports every line of a file it
  // loaded but never executed as coverable, and the collapsed set once the
  // file runs. Measured on apps/shared at --shard=i/3,
  // src/errors/negotiation.ts is LF:208 LH:0 in two shards and LF:98 LH:92 in
  // the third; a union of DA lines would report 208 coverable lines.
  it('takes the coverable-line shape from the shard that ran the file', () => {
    const unexercised = record(
      'src/a.ts',
      [3, 0],
      [
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
        [5, 0],
      ]
    );
    const exercised = record(
      'src/a.ts',
      [3, 3],
      [
        [1, 4],
        [3, 2],
      ]
    );

    const [merged] = mergeLcovRecords([parseLcovRecords(unexercised), parseLcovRecords(exercised)]);
    expect([...merged.lineHits.keys()]).toEqual([1, 3]);
    expect(merged.functionsFound).toBe(3);
    expect(merged.functionsHit).toBe(3);
  });

  it('sums hits for a line several shards executed', () => {
    const [merged] = mergeLcovRecords([
      parseLcovRecords(record('src/a.ts', [1, 1], [[1, 2]])),
      parseLcovRecords(record('src/a.ts', [1, 1], [[1, 5]])),
    ]);
    expect(merged.lineHits.get(1)).toBe(7);
  });

  it('covers a line hit by any shard even when the shape came from another', () => {
    const shapeShard = record(
      'src/a.ts',
      [2, 1],
      [
        [1, 3],
        [2, 0],
        [3, 0],
      ]
    );
    const otherShard = record(
      'src/a.ts',
      [2, 1],
      [
        [1, 0],
        [2, 9],
      ]
    );
    const [merged] = mergeLcovRecords([parseLcovRecords(shapeShard), parseLcovRecords(otherShard)]);
    expect(merged.lineHits.get(2)).toBe(9);
    expect(merged.lineHits.get(3)).toBe(0);
  });

  it('never reports more functions hit than found', () => {
    // Different lazy-parse states disagree on the function total, so the best
    // shard's hit count can exceed another's total. Uncapped, that renders as
    // more than 100% function coverage.
    const [merged] = mergeLcovRecords([
      parseLcovRecords(record('src/a.ts', [5, 5], [[1, 1]])),
      parseLcovRecords(
        record(
          'src/a.ts',
          [3, 0],
          [
            [1, 0],
            [2, 0],
          ]
        )
      ),
    ]);
    expect(merged.functionsHit).toBeLessThanOrEqual(merged.functionsFound);
  });

  it('keeps files only one shard saw', () => {
    const merged = mergeLcovRecords([
      parseLcovRecords(record('src/a.ts', [1, 1], [[1, 1]])),
      parseLcovRecords(record('src/b.ts', [1, 1], [[1, 1]])),
    ]);
    expect(merged.map((entry) => entry.sourcePath)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('formatLcov', () => {
  it('recomputes LF and LH from the merged line list rather than trusting the inputs', async () => {
    const merged = mergeLcovRecords([
      parseLcovRecords(
        record(
          'src/a.ts',
          [2, 1],
          [
            [1, 1],
            [2, 0],
          ]
        )
      ),
      parseLcovRecords(
        record(
          'src/a.ts',
          [2, 2],
          [
            [1, 0],
            [2, 4],
          ]
        )
      ),
    ]);
    const lcov = formatLcov(merged);
    expect(lcov).toContain('LF:2');
    expect(lcov).toContain('LH:2');
    expect(await summarize(lcov)).toMatchObject({
      lines: { total: 2, covered: 2, pct: 100 },
      functions: { total: 2, covered: 2 },
    });
  });

  it('round-trips through the parser', () => {
    const original = mergeLcovRecords([parseLcovRecords(record('src/a.ts', [1, 1], [[7, 2]]))]);
    expect(parseLcovRecords(formatLcov(original))).toEqual(original);
  });
});
