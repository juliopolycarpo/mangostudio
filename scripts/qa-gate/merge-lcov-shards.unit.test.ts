import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findLcovProblem,
  formatLcov,
  LcovMergeError,
  mergeLcovFiles,
  mergeLcovRecords,
  parseLcovRecords,
} from './merge-lcov-shards';
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

  it('keeps a hit line that only exists on a non-shape record', () => {
    // Two lazy-parse regions of the same file: the shape shard ran the most
    // lines, the other shard hit a region the shape never loaded. Dropping
    // that line underreports coverage; keeping the other record's zeros
    // would inflate the denominator.
    const shapeShard = record(
      'src/a.ts',
      [2, 1],
      [
        [1, 4],
        [2, 0],
        [3, 2],
      ]
    );
    const otherRegion = record(
      'src/a.ts',
      [2, 1],
      [
        [10, 1],
        [11, 0],
        [12, 0],
      ]
    );
    const [merged] = mergeLcovRecords([
      parseLcovRecords(shapeShard),
      parseLcovRecords(otherRegion),
    ]);
    expect(merged.lineHits.get(1)).toBe(4);
    expect(merged.lineHits.get(3)).toBe(2);
    expect(merged.lineHits.get(10)).toBe(1);
    expect(merged.lineHits.has(11)).toBe(false);
    expect(merged.lineHits.has(12)).toBe(false);
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
    expect(merged.functionsFound).toBe(5);
    expect(merged.functionsHit).toBe(5);
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

/** A record that carries `FN:`/`FNDA:` identities, as gcov-style producers emit them. */
const fnRecord = (
  sourcePath: string,
  functions: ReadonlyArray<[line: number, name: string, hits: number]>,
  lines: ReadonlyArray<[line: number, hits: number]> = [[1, 1]]
): string =>
  [
    'TN:',
    `SF:${sourcePath}`,
    ...functions.map(([line, name]) => `FN:${line},${name}`),
    ...functions.map(([, name, hits]) => `FNDA:${hits},${name}`),
    `FNF:${functions.length}`,
    `FNH:${functions.filter(([, , hits]) => hits > 0).length}`,
    ...lines.map(([line, hits]) => `DA:${line},${hits}`),
    `LF:${lines.length}`,
    `LH:${lines.filter(([, hits]) => hits > 0).length}`,
    'end_of_record',
  ].join('\n');

const mergedFunctions = (...reports: string[]) => {
  const [merged] = mergeLcovRecords(reports.map((report) => parseLcovRecords(report)));
  return { found: merged?.functionsFound, hit: merged?.functionsHit };
};

describe('function coverage per function identity', () => {
  it('counts a function hit in two shards once', () => {
    const merged = mergedFunctions(
      fnRecord('src/a.ts', [[1, 'parse', 3]]),
      fnRecord('src/a.ts', [[1, 'parse', 2]])
    );
    expect(merged).toEqual({ found: 1, hit: 1 });
  });

  it('unions the functions different shards hit instead of keeping the best shard', () => {
    const merged = mergedFunctions(
      fnRecord('src/a.ts', [
        [1, 'parse', 4],
        [5, 'render', 0],
      ]),
      fnRecord('src/a.ts', [
        [1, 'parse', 0],
        [5, 'render', 2],
      ])
    );
    // A shard-max lower bound would report 1 of 2 here.
    expect(merged).toEqual({ found: 2, hit: 2 });
  });

  it('keeps a function only a non-shape shard exercised, and drops its zero-hit padding', () => {
    const shape = fnRecord(
      'src/a.ts',
      [[1, 'parse', 1]],
      [
        [1, 1],
        [2, 1],
      ]
    );
    const other = fnRecord('src/a.ts', [
      [1, 'parse', 0],
      [9, 'lazy', 2],
      [12, 'never', 0],
    ]);
    expect(mergedFunctions(shape, other)).toEqual({ found: 2, hit: 2 });
  });

  it('writes FN/FNDA back so a second merge hop keeps the identities', () => {
    const once = mergeLcovRecords([
      parseLcovRecords(fnRecord('src/a.ts', [[1, 'parse', 1]])),
      parseLcovRecords(fnRecord('src/a.ts', [[1, 'parse', 0]])),
    ]);
    const lcov = formatLcov(once);
    expect(lcov).toContain('FN:1,parse');
    expect(lcov).toContain('FNDA:1,parse');
    expect(parseLcovRecords(lcov)).toEqual(once);
  });

  it('reads the FN:<start>,<end>,<name> form under the same identity', () => {
    const [parsed] = parseLcovRecords(
      'SF:src/a.ts\nFN:1,4,parse\nFNDA:2,parse\nFNF:1\nFNH:1\nDA:1,2\nend_of_record\n'
    );
    expect([...(parsed?.functionHits ?? [])]).toEqual([['1,parse', 2]]);
  });

  // Bun emits FNF/FNH only. There is no identity to union, so the merge stays
  // the documented lower bound rather than inventing one.
  it('falls back to the best shard, clamped, for records that carry only totals', () => {
    const merged = mergedFunctions(
      record('src/a.ts', [4, 3], [[1, 1]]),
      record('src/a.ts', [4, 2], [[1, 1]])
    );
    expect(merged).toEqual({ found: 4, hit: 3 });
  });
});

describe('merge order independence', () => {
  // Same hit count, different coverable sets: keeping "the first record seen"
  // made LF depend on which shard was listed first.
  const tied = [
    record(
      'src/a.ts',
      [5, 1],
      [
        [1, 1],
        [2, 1],
        [3, 0],
      ]
    ),
    record(
      'src/a.ts',
      [2, 1],
      [
        [1, 1],
        [2, 1],
      ]
    ),
    record('src/b.ts', [1, 1], [[1, 1]]),
  ];

  const permutations = <T>(items: readonly T[]): T[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, index) =>
          permutations(items.filter((_, other) => other !== index)).map((rest) => [item, ...rest])
        );

  it('writes the same LCOV for every shard order', () => {
    const outputs = permutations(tied).map((order) =>
      formatLcov(mergeLcovRecords(order.map((report) => parseLcovRecords(report))))
    );
    expect(new Set(outputs).size).toBe(1);
  });

  it('breaks a tie on hit count toward the larger coverable set', () => {
    const [merged] = mergeLcovRecords(tied.slice(0, 2).map((report) => parseLcovRecords(report)));
    expect(merged?.lineHits.size).toBe(3);
    expect(merged?.functionsFound).toBe(5);
  });

  it('sorts records by source path whatever order the shards listed them in', () => {
    const merged = mergeLcovRecords([
      parseLcovRecords(record('src/b.ts', [1, 1], [[1, 1]])),
      parseLcovRecords(record('src/a.ts', [1, 1], [[1, 1]])),
    ]);
    expect(merged.map((entry) => entry.sourcePath)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('findLcovProblem', () => {
  const complete = record('src/a.ts', [1, 1], [[1, 1]]);

  it('accepts a complete report', () => {
    expect(findLcovProblem(`${complete}\n`)).toBeNull();
  });

  it.each([
    ['empty', '', 'report is empty'],
    ['whitespace only', '\n  \n', 'report is empty'],
    ['without any SF record', 'TN:\n', 'report has no SF records'],
    [
      'cut off before the last end_of_record',
      complete.replace('\nend_of_record', ''),
      'truncated: record for src/a.ts has no end_of_record',
    ],
    [
      'with two records and no end_of_record between them',
      'SF:src/a.ts\nDA:1,1\nSF:src/b.ts\nDA:1,1\nend_of_record\n',
      'truncated: record for src/a.ts has no end_of_record',
    ],
    ['with a non-numeric hit count', 'SF:a.ts\nDA:1,x\nend_of_record\n', 'malformed line "DA:1,x"'],
    ['with a non-numeric total', 'SF:a.ts\nFNF:many\nend_of_record\n', 'malformed line "FNF:many"'],
  ])('rejects a report that is %s', (_label, text, expected) => {
    expect(findLcovProblem(text)).toBe(expected);
  });
});

describe('mergeLcovFiles', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const workspace = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'mango-lcov-merge-'));
    dirs.push(dir);
    return dir;
  };

  const report = async (dir: string, name: string, text: string) => {
    const path = join(dir, name, 'lcov.info');
    await Bun.write(path, text);
    return { shard: name, path };
  };

  const complete = (hits: number): string =>
    `${record('src/a.ts', [1, hits > 0 ? 1 : 0], [[1, hits]])}\n`;

  const failure = async (promise: Promise<unknown>): Promise<LcovMergeError> => {
    try {
      await promise;
    } catch (caught) {
      if (caught instanceof LcovMergeError) return caught;
      throw new Error(`expected LcovMergeError | received: ${String(caught)}`);
    }
    throw new Error('expected LcovMergeError | received: the merge succeeded');
  };

  it('fails on a missing shard report naming the shard, and writes nothing', async () => {
    const dir = await workspace();
    const out = join(dir, 'out.lcov');
    const present = await report(dir, 'test-shard-1', complete(1));

    const error = await failure(
      mergeLcovFiles(out, [present, { shard: 'test-shard-2', path: join(dir, 'gone.lcov') }])
    );

    expect(error.message).toContain('shard test-shard-2: missing report at');
    expect(error.message).not.toContain('shard test-shard-1');
    expect(await Bun.file(out).exists()).toBe(false);
  });

  it('removes a previous output so a failed merge cannot leave last run coverage behind', async () => {
    const dir = await workspace();
    const out = join(dir, 'out.lcov');
    await Bun.write(out, complete(1));

    await failure(mergeLcovFiles(out, [{ shard: 'test-shard-3', path: join(dir, 'gone.lcov') }]));

    expect(await Bun.file(out).exists()).toBe(false);
  });

  it('fails on a truncated shard report naming the shard', async () => {
    const dir = await workspace();
    const good = await report(dir, 'test-shard-1', complete(1));
    const cut = await report(dir, 'test-shard-2', complete(1).replace('end_of_record\n', ''));

    const error = await failure(mergeLcovFiles(join(dir, 'out.lcov'), [good, cut]));

    expect(error.problems).toEqual([
      {
        shard: 'test-shard-2',
        problem: 'truncated: record for src/a.ts has no end_of_record',
      },
    ]);
  });

  it('fails on an empty shard report rather than merging it as zero coverage', async () => {
    const dir = await workspace();
    const good = await report(dir, 'test-shard-1', complete(1));
    const empty = await report(dir, 'test-shard-2', '');

    const error = await failure(mergeLcovFiles(join(dir, 'out.lcov'), [good, empty]));

    expect(error.problems).toEqual([{ shard: 'test-shard-2', problem: 'report is empty' }]);
  });

  it('names every unusable shard, not only the first', async () => {
    const dir = await workspace();
    const empty = await report(dir, 'test-shard-1', '');
    const missing = { shard: 'test-shard-2', path: join(dir, 'gone.lcov') };

    const error = await failure(mergeLcovFiles(join(dir, 'out.lcov'), [empty, missing]));

    expect(error.problems.map((problem) => problem.shard)).toEqual([
      'test-shard-1',
      'test-shard-2',
    ]);
  });

  it('writes byte-identical output for every shard order', async () => {
    const dir = await workspace();
    const first = await report(dir, 'test-shard-1', complete(0));
    const second = await report(dir, 'test-shard-2', complete(3));
    const third = await report(dir, 'test-shard-3', complete(1));
    const outputs = new Set<string>();
    for (const order of [
      [first, second, third],
      [third, second, first],
      [second, third, first],
    ]) {
      const out = join(dir, `out-${outputs.size}.lcov`);
      expect(await mergeLcovFiles(out, order)).toBe(3);
      outputs.add(await Bun.file(out).text());
    }
    expect(outputs.size).toBe(1);
  });

  it('accepts plain paths and reports them as the shard name', async () => {
    const dir = await workspace();

    const error = await failure(mergeLcovFiles(join(dir, 'out.lcov'), [join(dir, 'nope.lcov')]));

    expect(error.problems[0]?.shard).toBe(join(dir, 'nope.lcov'));
  });

  it('refuses an empty input set', async () => {
    const dir = await workspace();
    await expect(mergeLcovFiles(join(dir, 'out.lcov'), [])).rejects.toThrow(
      /No shard LCOV inputs were given/
    );
  });
});
