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
// Function coverage merges per function identity when the shards carry
// `FN:`/`FNDA:` records: the same function hit in two shards counts once. Bun
// (1.4.2, checked on every shard artifact of a CI run) emits only the
// `FNF`/`FNH` totals, so for its LCOV there is no identity to union. Those
// records fall back to a lower bound, the best shard's `FNH` clamped to the
// shape's `FNF`, which never double-counts but undercounts when shards hit
// different functions. Measured drift against an unsharded run on
// `apps/runtime`: lines −0.47/−0.55/−0.54pp and functions −1.60/−2.00/−2.52pp
// at 2/4/8 shards. Lines are flat past two shards and are the only figure the
// QA verdict reads; functions creep with N and are a table entry.
//
// The merge is a pure function of the *set* of shard reports: the shape record
// is picked by a total order and the output is sorted by source path, so any
// shard order writes the same bytes. It also refuses to guess about its
// inputs: a missing, unreadable, empty or truncated shard report fails the
// merge naming that shard, and nothing is written, so a lower complete-looking
// number can never stand in for a report that did not arrive.
//
// Usage: bun ./scripts/qa-gate/merge-lcov-shards.ts <out.lcov> <shard1.lcov> <shard2.lcov> ...

import { rm } from 'node:fs/promises';

export interface LcovRecord {
  readonly sourcePath: string;
  readonly functionsFound: number;
  readonly functionsHit: number;
  /** `DA:<line>,<hits>` for this record, in file order. */
  readonly lineHits: ReadonlyMap<number, number>;
  /**
   * `FN:`/`FNDA:` hits keyed by function identity, `<line>,<name>`. Empty when
   * the producer emits only the `FNF`/`FNH` totals, as Bun does.
   */
  readonly functionHits: ReadonlyMap<string, number>;
}

/** One shard's report and the name the merge reports it under. */
export interface LcovShardInput {
  readonly shard: string;
  readonly path: string;
}

/** A shard report the merge could not use, and why. */
export interface LcovInputProblem {
  readonly shard: string;
  readonly problem: string;
}

/**
 * Thrown before anything is written when any shard report is unusable; the
 * message names every offending shard, not just the first.
 */
export class LcovMergeError extends Error {
  constructor(
    readonly outPath: string,
    readonly problems: readonly LcovInputProblem[]
  ) {
    super(
      // Shard names lead: consumers clip long reasons, and the name is the part that matters.
      `${problems.map(({ shard, problem }) => `shard ${shard}: ${problem}`).join('; ')}. ` +
        'Expected a readable, non-empty LCOV report whose records each end with end_of_record ' +
        `(merging into ${outPath}).`
    );
    this.name = 'LcovMergeError';
  }
}

const countHit = (hitsByKey: ReadonlyMap<unknown, number>): number => {
  let hit = 0;
  for (const hits of hitsByKey.values()) if (hits > 0) hit++;
  return hit;
};

const isCount = (text: string | undefined): boolean => /^\d+$/.test(text ?? '');

/** `FN:<start>,<name>` or `FN:<start>,<end>,<name>` -> identity `<start>,<name>`. */
const functionKey = (payload: string): string | null => {
  const [start, ...rest] = payload.split(',');
  const name = isCount(rest[0]) && rest.length > 1 ? rest.slice(1) : rest;
  if (!isCount(start) || name.length === 0) return null;
  return `${start},${name.join(',')}`;
};

const nameOfKey = (key: string): string => key.slice(key.indexOf(',') + 1);

/**
 * Parse the `SF`/`FN`/`FNDA`/`FNF`/`FNH`/`DA` subset LCOV producers emit.
 * `LF:`/`LH:` are recomputed from `DA:` rather than trusted, so a merged record
 * can never disagree with its own line list. Lenient by design; completeness
 * is checked separately by `findLcovProblem`.
 * // Usage: parseLcovRecords(await Bun.file('lcov.info').text());
 */
export const parseLcovRecords = (text: string): readonly LcovRecord[] => {
  const records: LcovRecord[] = [];
  let sourcePath: string | null = null;
  let functionsFound = 0;
  let functionsHit = 0;
  let lineHits = new Map<number, number>();
  let functionHits = new Map<string, number>();
  let keyByName = new Map<string, string>();

  const flush = (): void => {
    if (sourcePath !== null) {
      records.push({ sourcePath, functionsFound, functionsHit, lineHits, functionHits });
    }
    sourcePath = null;
    functionsFound = 0;
    functionsHit = 0;
    lineHits = new Map<number, number>();
    functionHits = new Map<string, number>();
    keyByName = new Map<string, string>();
  };

  const recordFunction = (payload: string): void => {
    const key = functionKey(payload);
    if (key === null) return;
    keyByName.set(nameOfKey(key), key);
    if (!functionHits.has(key)) functionHits.set(key, 0);
  };

  // LCOV ties `FNDA:` to its function by name alone, so of several functions
  // sharing a name the last `FN:` seen owns the hits, so same-name functions
  // are attributed best-effort (Bun emits neither record, so none occur today).
  const recordFunctionHits = (payload: string): void => {
    const split = payload.indexOf(',');
    const hits = Number(payload.slice(0, split));
    if (split < 0 || !Number.isFinite(hits)) return;
    const name = payload.slice(split + 1);
    const key = keyByName.get(name) ?? `0,${name}`;
    functionHits.set(key, (functionHits.get(key) ?? 0) + hits);
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
    } else if (line.startsWith('FNDA:')) {
      recordFunctionHits(line.slice(5));
    } else if (line.startsWith('FN:')) {
      recordFunction(line.slice(3));
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

const NUMERIC_FIELDS = ['FNF:', 'FNH:', 'LF:', 'LH:'] as const;

const malformedField = (line: string): boolean => {
  if (line.startsWith('DA:')) {
    const [lineNumber, hits] = line.slice(3).split(',').map(Number);
    return !Number.isFinite(lineNumber) || !Number.isFinite(hits);
  }
  if (!NUMERIC_FIELDS.some((field) => line.startsWith(field))) return false;
  return !Number.isFinite(Number(line.slice(line.indexOf(':') + 1)));
};

/**
 * Why an LCOV report cannot be trusted as a complete shard report, or null
 * when it can: empty, no `SF:` record, a malformed count, or a last record the
 * writer never closed with `end_of_record` (a truncated upload or a killed run).
 * // Usage: const problem = findLcovProblem(text); if (problem) throw new Error(problem);
 */
export const findLcovProblem = (text: string): string | null => {
  if (text.trim().length === 0) return 'report is empty';
  let openRecord: string | null = null;
  let records = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('SF:')) {
      if (openRecord !== null) return `truncated: record for ${openRecord} has no end_of_record`;
      openRecord = line.slice(3) || '(empty path)';
      records++;
    } else if (line === 'end_of_record') {
      openRecord = null;
    } else if (malformedField(line)) {
      return `malformed line "${line}"`;
    }
  }
  if (records === 0) return 'report has no SF records';
  if (openRecord !== null) return `truncated: record for ${openRecord} has no end_of_record`;
  return null;
};

const signature = (keys: Iterable<string | number>): string =>
  [...keys].map(String).sort().join('\n');

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Total order on records of one source file: how much of it ran, then how much
 * of it there is, then the exact line and function sets. Ties on the counts
 * alone would otherwise keep whichever shard happened to come first.
 */
const compareShape = (a: LcovRecord, b: LcovRecord): number =>
  countHit(a.lineHits) - countHit(b.lineHits) ||
  a.lineHits.size - b.lineHits.size ||
  a.functionsFound - b.functionsFound ||
  compareText(signature(a.lineHits.keys()), signature(b.lineHits.keys())) ||
  compareText(signature(a.functionHits.keys()), signature(b.functionHits.keys()));

/**
 * Sum hits per key across the group. The shape record owns the key set (the
 * coverable denominator); a positive-hit key that only exists on another record
 * is kept because a shard exercised a lazily parsed region the shape never
 * loaded, while that record's zero-hit padding is dropped.
 */
const mergeHits = <K>(
  shape: ReadonlyMap<K, number>,
  group: readonly ReadonlyMap<K, number>[]
): Map<K, number> => {
  const summed = new Map<K, number>();
  for (const hitsByKey of group) {
    for (const [key, hits] of hitsByKey) summed.set(key, (summed.get(key) ?? 0) + hits);
  }
  const merged = new Map<K, number>();
  for (const key of shape.keys()) merged.set(key, summed.get(key) ?? 0);
  for (const [key, hits] of summed) if (hits > 0 && !merged.has(key)) merged.set(key, hits);
  return merged;
};

/** True when every record with functions carries `FN:` identities to merge by. */
const hasFunctionIdentities = (group: readonly LcovRecord[]): boolean =>
  group.some((record) => record.functionHits.size > 0) &&
  group.every((record) => record.functionHits.size > 0 || record.functionsFound === 0);

/**
 * Merge one source file's records from several shards. The record that covered
 * the most lines supplies the coverable-line set; hits are summed across every
 * shard that touched the file. Functions merge by identity when the records
 * carry `FN:`/`FNDA:`; otherwise they are a lower bound (see the header).
 */
const mergeRecordGroup = (group: readonly LcovRecord[]): LcovRecord => {
  const shape = group.reduce((best, candidate) =>
    compareShape(candidate, best) > 0 ? candidate : best
  );
  const lineHits = mergeHits(
    shape.lineHits,
    group.map((record) => record.lineHits)
  );

  if (hasFunctionIdentities(group)) {
    const functionHits = mergeHits(
      shape.functionHits,
      group.map((record) => record.functionHits)
    );
    return {
      sourcePath: shape.sourcePath,
      functionsFound: functionHits.size,
      functionsHit: countHit(functionHits),
      lineHits,
      functionHits,
    };
  }

  // Without per-function records the union of hit functions is not
  // recoverable. The best shard is a lower bound; clamp it to the shape's
  // total so FNH can never exceed FNF and render as more than 100%.
  const functionsHit = Math.min(
    group.reduce((max, record) => Math.max(max, record.functionsHit), 0),
    shape.functionsFound
  );
  return {
    sourcePath: shape.sourcePath,
    functionsFound: shape.functionsFound,
    functionsHit,
    lineHits,
    functionHits: new Map<string, number>(),
  };
};

/**
 * Merge per-shard record lists into one, sorted by source path so the result
 * does not depend on the order the shards arrive in.
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
  return [...grouped.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([, group]) => mergeRecordGroup(group));
};

/** Render records back into the LCOV subset Bun emits, plus `FN`/`FNDA` when a record has them. */
export const formatLcov = (records: readonly LcovRecord[]): string => {
  const out: string[] = [];
  for (const record of records) {
    out.push('TN:', `SF:${record.sourcePath}`);
    const functions = [...record.functionHits].sort(([a], [b]) => compareText(a, b));
    for (const [key] of functions) out.push(`FN:${key}`);
    for (const [key, hits] of functions) out.push(`FNDA:${hits},${nameOfKey(key)}`);
    out.push(`FNF:${record.functionsFound}`, `FNH:${record.functionsHit}`);
    for (const [line, hits] of [...record.lineHits].sort(([a], [b]) => a - b)) {
      out.push(`DA:${line},${hits}`);
    }
    out.push(`LF:${record.lineHits.size}`, `LH:${countHit(record.lineHits)}`, 'end_of_record');
  }
  return `${out.join('\n')}\n`;
};

const readShard = async (
  input: LcovShardInput
): Promise<{ records: readonly LcovRecord[] } | { problem: string }> => {
  const file = Bun.file(input.path);
  if (!(await file.exists())) return { problem: `missing report at ${input.path}` };
  let text: string;
  try {
    text = await file.text();
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    return { problem: `unreadable report at ${input.path} (${reason})` };
  }
  const problem = findLcovProblem(text);
  return problem === null ? { records: parseLcovRecords(text) } : { problem };
};

/**
 * Merge shard LCOV reports into one file. Every input is required: a missing,
 * unreadable, empty or truncated report throws `LcovMergeError` naming each
 * such shard, and no output is written. Any earlier `outPath` is removed first,
 * so a failed merge can never leave a previous run's file to be read as this
 * one's. A caller that expects some shards to legitimately write nothing (a
 * slice with no file from a workspace) passes only the reports that exist.
 * Returns the number of inputs merged.
 * // Usage: await mergeLcovFiles('coverage/api/lcov.info', [{ shard: 'test-shard-1', path }]);
 */
export const mergeLcovFiles = async (
  outPath: string,
  inputs: readonly (LcovShardInput | string)[]
): Promise<number> => {
  await rm(outPath, { force: true });
  if (inputs.length === 0) throw new Error(`No shard LCOV inputs were given for ${outPath}`);

  const named = inputs.map((input) =>
    typeof input === 'string' ? { shard: input, path: input } : input
  );
  const problems: LcovInputProblem[] = [];
  const shards: (readonly LcovRecord[])[] = [];
  for (const input of named) {
    const result = await readShard(input);
    if ('problem' in result) problems.push({ shard: input.shard, problem: result.problem });
    else shards.push(result.records);
  }
  if (problems.length > 0) throw new LcovMergeError(outPath, problems);

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
