import type { RunResult } from '../../lib/exec';
import type { ProtocolTask } from '../../protocol/tasks';

/** How a configuration with no feature enabled is spelled in a configuration list. */
export const NO_FEATURES = '<no features>';

/**
 * Every feature combination `cargo hack --feature-powerset` runs for a crate's
 * `[features]` table: all subsets, minus those that name a feature another
 * member already enables (`testing` enables `tokio`, so `testing,tokio` is not
 * a configuration). A configuration is its sorted feature names, comma-joined.
 *
 * @example
 * featurePowerset({ a: [], b: ['a'] }); // → ['<no features>', 'a', 'b']
 */
export function featurePowerset(features: Readonly<Record<string, readonly string[]>>): string[] {
  const names = Object.keys(features).sort();
  const enables = (name: string, seen = new Set<string>()): Set<string> => {
    for (const entry of features[name] ?? []) {
      if (!(entry in features) || seen.has(entry)) continue;
      seen.add(entry);
      enables(entry, seen);
    }
    return seen;
  };
  const implied = new Map(names.map((name) => [name, enables(name)]));

  const configurations: string[] = [];
  for (let mask = 0; mask < 2 ** names.length; mask += 1) {
    const picked = names.filter((_, bit) => mask & (2 ** bit));
    const redundant = picked.some((name) => picked.some((other) => implied.get(other)?.has(name)));
    if (!redundant) configurations.push(picked.join(',') || NO_FEATURES);
  }
  return configurations;
}

/** What a fake `cargo hack` was asked to run, and which configurations that selected. */
export interface RecordedHackRun {
  readonly label: string;
  readonly partition: string | undefined;
  readonly targetDir: string | undefined;
  readonly configurations: readonly string[];
}

export interface FakeCargoHackBehavior {
  /** Exit code per task label; a label not listed exits 0. */
  readonly exitCodes?: Readonly<Record<string, number>>;
  /** Labels whose spawn is refused, as when the binary cannot be executed. */
  readonly neverStarts?: ReadonlySet<string>;
}

/**
 * A recording stand-in for `cargo hack clippy --feature-powerset`: it runs no
 * compiler. Given a task it records the target directory and which of
 * `configurations` the task's `--partition <index>/<count>` selects — the first
 * `ceil(total / count)` for slice 1, the next for slice 2, as cargo-hack does —
 * or all of them when the command carries no `--partition`.
 *
 * @example
 * const cargo = new FakeCargoHack(featurePowerset(features));
 * await cargo.run(task);
 * cargo.runs[0]?.configurations;
 */
export class FakeCargoHack {
  readonly runs: RecordedHackRun[] = [];
  maxInFlight = 0;
  private inFlight = 0;

  constructor(
    private readonly configurations: readonly string[],
    private readonly behavior: FakeCargoHackBehavior = {}
  ) {}

  readonly run = async (task: ProtocolTask): Promise<RunResult> => {
    if (this.behavior.neverStarts?.has(task.label)) {
      throw new Error(`spawn ${task.cmd[0]} ENOENT`);
    }
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    // A macrotask, so every task a caller starts together is in flight before any ends.
    await Bun.sleep(0);
    this.runs.push({
      label: task.label,
      partition: partitionFlag(task.cmd),
      targetDir: task.env?.CARGO_TARGET_DIR,
      configurations: this.select(task.cmd),
    });
    this.inFlight -= 1;
    return { label: task.label, exitCode: this.behavior.exitCodes?.[task.label] ?? 0, duration: 0 };
  };

  private select(cmd: readonly string[]): string[] {
    const flag = partitionFlag(cmd);
    if (flag === undefined) return [...this.configurations];
    const match = /^(\d+)\/(\d+)$/.exec(flag);
    const index = Number(match?.[1]);
    const count = Number(match?.[2]);
    if (!match || index < 1 || index > count) {
      throw new Error(
        `expected --partition <index>/<count> with 1 <= index <= count | received: ${flag}`
      );
    }
    const size = Math.ceil(this.configurations.length / count);
    return this.configurations.slice((index - 1) * size, index * size);
  }
}

function partitionFlag(cmd: readonly string[]): string | undefined {
  const at = cmd.indexOf('--partition');
  return at === -1 ? undefined : cmd[at + 1];
}

/**
 * Why `runs` do not run each of `expected` exactly once, naming the missing and
 * the duplicated configurations; `null` when they do.
 *
 * @example
 * coverageProblems(['a', 'b'], [{ ...run, configurations: ['a'] }]);
 * // → 'expected 2 configurations, each run once | missing: b | duplicated: none'
 */
export function coverageProblems(
  expected: readonly string[],
  runs: readonly RecordedHackRun[]
): string | null {
  const seen = new Map<string, number>();
  for (const run of runs) {
    for (const configuration of run.configurations) {
      seen.set(configuration, (seen.get(configuration) ?? 0) + 1);
    }
  }
  const missing = expected.filter((configuration) => !seen.has(configuration));
  const duplicated = [...seen].filter(([, times]) => times > 1).map(([name]) => name);
  const unknown = [...seen.keys()].filter((name) => !expected.includes(name));
  if (missing.length + duplicated.length + unknown.length === 0) return null;
  const list = (names: readonly string[]): string => (names.length ? names.join(' ; ') : 'none');
  return [
    `expected ${expected.length} configurations, each run once`,
    `missing: ${list(missing)}`,
    `duplicated: ${list(duplicated)}`,
    `not in the powerset: ${list(unknown)}`,
  ].join(' | ');
}
