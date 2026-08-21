// Merge the per-shard LCOV files a sharded test lane produces into the single
// per-workspace lcov.info the coverage readers expect.
//
// Concatenating them is wrong, and so is a plain union of `DA:` lines. Bun's
// per-file `LF:`/`FNF:` are *run-dependent*: a source file a shard loaded but
// never exercised reports every one of its lines as coverable, while the same
// file under a shard that ran its code reports the collapsed set that lazy
// parsing leaves behind. Measured on `apps/shared` at `--shard=i/3`,
// `src/errors/negotiation.ts` is `LF:208 LH:0` in two shards and `LF:98 LH:92`
// in the third. Union every `DA:` line and the denominator inflates: 15,303
// coverable lines against the unsharded run's 14,740, reporting 94.26% where
// the truth is 97.86%.
//
// So the shape wins from the record that ran the most of the file, and coverage
// is the union of what any shard hit. Same corpus, same three shards: 97.86%
// lines against 97.86%.
//
// Function coverage stays approximate and cannot be fixed here — Bun emits no
// per-function records to union. Measured drift against an unsharded run on
// `apps/runtime`: lines −0.47/−0.55/−0.54pp and functions −1.60/−2.00/−2.52pp
// at 2/4/8 shards. Lines are flat past two shards and are the only figure the
// QA verdict reads; functions creep with N and are a table entry.
//
// Usage: bun ./scripts/qa-gate/merge-lcov-shards.ts <out.lcov> <shard1.lcov> <shard2.lcov> ...

export interface LcovRecord {
  readonly sourcePath: string;
  readonly functionsFound: number;
  readonly functionsHit: number;
  /** `DA:<line>,<hits>` for this record, in file order. */
  readonly lineHits: ReadonlyMap<number, number>;
}

const countHit = (lineHits: ReadonlyMap<number, number>): number => {
  let hit = 0;
  for (const hits of lineHits.values()) if (hits > 0) hit++;
  return hit;
};

/**
 * Parse the `SF`/`FNF`/`FNH`/`DA` subset Bun's LCOV reporter emits. `LF:`/`LH:`
 * are recomputed from `DA:` rather than trusted, so a merged record can never
 * disagree with its own line list.
 * // Usage: parseLcovRecords(await Bun.file('lcov.info').text());
 */
export const parseLcovRecords = (text: string): readonly LcovRecord[] => {
  const records: LcovRecord[] = [];
  let sourcePath: string | null = null;
  let functionsFound = 0;
  let functionsHit = 0;
  let lineHits = new Map<number, number>();

  const flush = (): void => {
    if (sourcePath !== null) records.push({ sourcePath, functionsFound, functionsHit, lineHits });
    sourcePath = null;
    functionsFound = 0;
    functionsHit = 0;
    lineHits = new Map<number, number>();
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      flush();
      sourcePath = line.slice(3);
      continue;
    }
    // Everything else belongs to the record `SF:` opened; a stray `DA:` before
    // the first one is preamble, not coverage.
    if (sourcePath === null) continue;

    if (line.startsWith('FNF:')) {
      functionsFound = Number(line.slice(4));
    } else if (line.startsWith('FNH:')) {
      functionsHit = Number(line.slice(4));
    } else if (line.startsWith('DA:')) {
      const [lineNumber, hits] = line.slice(3).split(',').map(Number);
      if (Number.isFinite(lineNumber) && Number.isFinite(hits)) lineHits.set(lineNumber, hits);
    } else if (line === 'end_of_record') {
      flush();
    }
  }

  flush();
  return records;
};

/**
 * Merge one source file's records from several shards. The record that covered
 * the most lines supplies the coverable-line set and the function total; hits
 * are summed across every shard that touched the file. Positive-hit lines that
 * only exist on a non-shape record are kept; other records' zero-hit padding
 * is not.
 */
const mergeRecordGroup = (group: readonly LcovRecord[]): LcovRecord => {
  const shape = group.reduce((best, candidate) =>
    countHit(candidate.lineHits) > countHit(best.lineHits) ? candidate : best
  );

  const summedHits = new Map<number, number>();
  for (const record of group) {
    for (const [line, hits] of record.lineHits) {
      summedHits.set(line, (summedHits.get(line) ?? 0) + hits);
    }
  }

  const lineHits = new Map<number, number>();
  for (const line of shape.lineHits.keys()) lineHits.set(line, summedHits.get(line) ?? 0);
  // A shard that exercised a lazily parsed region the shape record never loaded
  // still owns those hits. Keep the positive-hit lines; drop the other
  // records' zero-hit padding so the denominator does not inflate.
  for (const [line, hits] of summedHits) {
    if (hits > 0 && !lineHits.has(line)) lineHits.set(line, hits);
  }

  // Bun reports only the FNF/FNH totals, never per-function `FN:`/`FNDA:`
  // records, so the union of hit functions is not recoverable. The best shard
  // is a lower bound; clamp it to the shape's total so FNH can never exceed
  // FNF and render as more than 100%.
  const functionsHit = Math.min(
    group.reduce((max, record) => Math.max(max, record.functionsHit), 0),
    shape.functionsFound
  );

  return {
    sourcePath: shape.sourcePath,
    functionsFound: shape.functionsFound,
    functionsHit,
    lineHits,
  };
};

/**
 * Merge per-shard record lists into one, preserving first-seen source order.
 * // Usage: mergeLcovRecords([parseLcovRecords(a), parseLcovRecords(b)]);
 */
export const mergeLcovRecords = (
  shards: readonly (readonly LcovRecord[])[]
): readonly LcovRecord[] => {
  const grouped = new Map<string, LcovRecord[]>();
  for (const shard of shards) {
    for (const record of shard) {
      const group = grouped.get(record.sourcePath);
      if (group) group.push(record);
      else grouped.set(record.sourcePath, [record]);
    }
  }
  return [...grouped.values()].map(mergeRecordGroup);
};

/** Render records back into the LCOV subset Bun emits. */
export const formatLcov = (records: readonly LcovRecord[]): string => {
  const out: string[] = [];
  for (const record of records) {
    out.push('TN:', `SF:${record.sourcePath}`);
    out.push(`FNF:${record.functionsFound}`, `FNH:${record.functionsHit}`);
    for (const [line, hits] of [...record.lineHits].sort(([a], [b]) => a - b)) {
      out.push(`DA:${line},${hits}`);
    }
    out.push(`LF:${record.lineHits.size}`, `LH:${countHit(record.lineHits)}`, 'end_of_record');
  }
  return `${out.join('\n')}\n`;
};

/**
 * Merge shard LCOV files into one. Missing inputs are skipped: a shard whose
 * slice contained no file from this workspace legitimately writes nothing.
 * Returns the number of inputs that existed.
 * // Usage: await mergeLcovFiles('coverage/api/lcov.info', shardPaths);
 */
export const mergeLcovFiles = async (
  outPath: string,
  inputPaths: readonly string[]
): Promise<number> => {
  const shards: (readonly LcovRecord[])[] = [];
  for (const path of inputPaths) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    shards.push(parseLcovRecords(await file.text()));
  }
  if (shards.length === 0) {
    throw new Error(`No shard LCOV inputs existed for ${outPath}: ${inputPaths.join(', ')}`);
  }
  await Bun.write(outPath, formatLcov(mergeLcovRecords(shards)));
  return shards.length;
};

if (import.meta.main) {
  const [, , outPath, ...inputPaths] = process.argv;
  if (!outPath || inputPaths.length === 0) {
    process.stderr.write(
      'Usage: bun ./scripts/qa-gate/merge-lcov-shards.ts <out.lcov> <shard.lcov> [shard.lcov ...]\n'
    );
    process.exit(1);
  }
  const merged = await mergeLcovFiles(outPath, inputPaths);
  process.stderr.write(`Merged ${merged} shard LCOV file(s) into ${outPath}\n`);
}
