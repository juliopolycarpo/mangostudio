// A model of the two cargo-hack behaviours the Protocol CI partitions rely on,
// as of cargo-hack 0.6.45 (the version both protocol workflows install; the
// pin test next to the workflows holds the two together). The source is
// `src/features.rs` (`feature_powerset`) and `src/main.rs` (`Progress::in_partition`).
// The tests ground the model against the list the real binary printed, so a
// drift in either shows up as a different set, not as a silent partition gap.

/** A `[features]` table: feature name to the entries it enables. */
export type FeatureTable = Readonly<Record<string, readonly string[]>>;

/**
 * Every feature a feature enables, through any chain of own features. `dep:x`
 * and `crate/feature` entries name a dependency, not a feature of this crate,
 * and cargo-hack does not follow them.
 */
function impliedFeatures(table: FeatureTable, root: string): Set<string> {
  const implied = new Set<string>();
  const pending = [root];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const entry of table[next] ?? []) {
      if (entry === root || implied.has(entry) || !(entry in table)) continue;
      implied.add(entry);
      pending.push(entry);
    }
  }
  return implied;
}

/**
 * The feature sets `cargo hack --feature-powerset` runs for one package,
 * including the empty set (`--no-default-features`). A set that names a
 * feature together with another feature it already enables is skipped, which
 * is why `tokio` never appears beside `spawn`, `testing` or `websocket`.
 * Each set is sorted; the order of the list is not cargo-hack's.
 *
 * @example
 * powersetConfigurations({ a: [], b: ['a'] }); // [[], ['a'], ['b']]
 */
export function powersetConfigurations(table: FeatureTable): string[][] {
  const names = Object.keys(table);
  const implied = new Map(names.map((name) => [name, impliedFeatures(table, name)]));
  const configurations: string[][] = [];
  for (let mask = 0; mask < 2 ** names.length; mask += 1) {
    const set = names.filter((_, bit) => (mask >> bit) & 1).sort();
    const redundant = set.some((feature) =>
      set.some((other) => other !== feature && implied.get(feature)?.has(other))
    );
    if (!redundant) configurations.push(set);
  }
  return configurations;
}

/**
 * The 0-based partition cargo-hack gives the run at 0-based position `run` of
 * `total` runs when asked for `count` partitions: contiguous chunks of
 * `ceil(total / count)` runs, in the order it executes them.
 *
 * @example
 * partitionOfRun(17, 36, 2); // 0
 * partitionOfRun(18, 36, 2); // 1
 */
export function partitionOfRun(run: number, total: number, count: number): number {
  return Math.floor(run / Math.ceil(total / count));
}

/** What a set of `--partition M/N` selections does to an ordered run list. */
export interface PartitionCoverage {
  /** Runs no selected partition executes. */
  readonly missing: string[];
  /** Runs more than one selection executes (a partition listed twice). */
  readonly duplicated: string[];
  /** Selected partitions that execute nothing, which cargo-hack reports as success. */
  readonly idle: number[];
  /** Selections outside `1..count`, which cargo-hack rejects. */
  readonly invalid: number[];
}

/**
 * Which runs `selected` (1-based partition numbers out of `count`) execute,
 * judged against `runs` in cargo-hack's execution order.
 *
 * @example
 * partitionCoverage(['a', 'b'], 2, [1]).missing; // ['b']
 */
export function partitionCoverage(
  runs: readonly string[],
  count: number,
  selected: readonly number[]
): PartitionCoverage {
  const executed = new Map<string, number>();
  const idle: number[] = [];
  const invalid = selected.filter((partition) => partition < 1 || partition > count);
  for (const partition of selected.filter((value) => !invalid.includes(value))) {
    const own = runs.filter((_, run) => partitionOfRun(run, runs.length, count) === partition - 1);
    if (own.length === 0) idle.push(partition);
    for (const name of own) executed.set(name, (executed.get(name) ?? 0) + 1);
  }
  return {
    missing: runs.filter((name) => !executed.has(name)),
    duplicated: runs.filter((name) => (executed.get(name) ?? 0) > 1),
    idle,
    invalid,
  };
}
