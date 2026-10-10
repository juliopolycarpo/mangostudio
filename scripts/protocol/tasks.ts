/**
 * The protocol lanes, as data. `check.ts` and `test.ts` turn these into spawned
 * commands; keeping the selection pure is what lets a unit test assert which
 * lanes a flag combination produces without running any of them.
 *
 * @example
 * protocolCheckTasks(['--ts-only']).map((task) => task.label);
 */

import { join } from 'node:path';
import { TYPECHECK_TASK } from '../lib/check';
import { ROOT_DIR } from '../lib/config';
import { cargoTargetDir } from '../lib/runtime-build';
import { hasCargo, hasCargoHack, warnNoCargo, warnNoCargoHack } from './toolchain';

/**
 * One slice of a command that is run as `count` slices at once. The command
 * only counts as run when every slice from 1 to `count` ran and passed, which
 * `run-tasks.ts` enforces.
 */
interface ProtocolPartition {
  readonly group: string;
  /** 1-based, so it reads the same as cargo-hack's `--partition <index>/<count>`. */
  readonly index: number;
  readonly count: number;
}

export interface ProtocolTask {
  readonly label: string;
  readonly cmd: string[];
  readonly env?: Record<string, string>;
  readonly partition?: ProtocolPartition;
}

/**
 * What the machine running the lanes has installed. Injected so a test can ask
 * for the toolchain-less machine without mocking `./toolchain`, whose module
 * namespace this file imports four symbols from.
 */
export interface ToolchainProbe {
  readonly cargo: boolean;
  readonly cargoHack: boolean;
}

/** What is actually on PATH; the default for both selectors. */
function probeToolchain(): ToolchainProbe {
  return { cargo: hasCargo(), cargoHack: hasCargoHack() };
}

/**
 * A run narrowed to Rust must find the toolchain it asked for. The default
 * combined run still degrades to the TypeScript half with a warning, but
 * `--rs-only` with no Cargo produced an empty task list, and an empty list is
 * reported as "All tasks passed." — a green for the one command that explicitly
 * asked for Rust validation and ran none of it.
 */
function assertRustToolchain(typescript: boolean, cargo: boolean): void {
  if (typescript || cargo) return;
  throw new Error(
    'Received --rs-only but cargo is not on PATH; install a Rust toolchain, or drop the flag to run the TypeScript half.'
  );
}

/** Which halves of the contract a flag set selects. */
export interface ProtocolLaneSelection {
  readonly typescript: boolean;
  readonly rust: boolean;
  readonly format: boolean;
}

/**
 * `--ts-only` and `--rs-only` narrow the run to one half; passing both is a
 * contradiction and is rejected rather than silently resolving to nothing.
 *
 * @example
 * selectLanes(['--rs-only']); // { typescript: false, rust: true, format: true }
 */
export function selectLanes(args: readonly string[]): ProtocolLaneSelection {
  const tsOnly = args.includes('--ts-only');
  const rsOnly = args.includes('--rs-only');
  if (tsOnly && rsOnly) {
    throw new Error(
      'Received both --ts-only and --rs-only; expected at most one, or neither to run both halves.'
    );
  }
  return { typescript: !rsOnly, rust: !tsOnly, format: !args.includes('--skip-format') };
}

const CARGO_CLIPPY = [
  'cargo',
  'clippy',
  '-p',
  'mango-protocol',
  '--all-targets',
  '--all-features',
  '--locked',
  '--',
  '-D',
  'warnings',
];

function typescriptCheckTasks(tsOnly: boolean, cargo: boolean): ProtocolTask[] {
  return [
    {
      // Through Turbo rather than a bare `tsc`, so both tasks are cached the
      // same way the application workspaces' are. Biome and dprint are absent
      // on purpose: the repository root already lints this package's sources.
      label: 'protocol:workspace',
      cmd: [
        'turbo',
        'run',
        TYPECHECK_TASK,
        'circular',
        '--ui=stream',
        '--filter=@mangostudio/protocol',
      ],
    },
    { label: 'protocol:versions', cmd: ['bun', './scripts/protocol/check-versions.ts'] },
    { label: 'protocol:verify-spec', cmd: ['bun', './scripts/protocol/verify-spec.ts'] },
    {
      label: 'protocol:schema-equality',
      cmd: [
        'bun',
        './scripts/protocol/verify-schema-equality.ts',
        ...(tsOnly || !cargo ? ['--ts-only'] : []),
      ],
    },
    {
      label: 'protocol:fixtures:chunks',
      cmd: ['bun', './scripts/protocol/fixtures/generate-chunks.ts', '--check'],
    },
    {
      label: 'protocol:fixtures:ssh-argv',
      cmd: ['bun', './scripts/protocol/fixtures/generate-ssh-argv.ts', '--check'],
    },
    {
      label: 'protocol:fixtures:catalog-example',
      cmd: ['bun', './scripts/protocol/fixtures/generate-catalog-example.ts', '--check'],
    },
  ];
}

/** The label the partitioned feature-powerset run is reported under. */
const FEATURE_POWERSET_LABEL = 'protocol:feature-powerset';

/** How many slices the feature powerset is cut into, each with a target directory of its own. */
const FEATURE_POWERSET_PARTITIONS = 2;

/**
 * The feature powerset as `FEATURE_POWERSET_PARTITIONS` disjoint cargo-hack
 * partitions that run at the same time. Each builds into its own directory under
 * `targetRoot`: partitions sharing one target queue on its build-directory lock
 * and finish barely sooner than the single command did.
 *
 * @example
 * featurePowersetTasks('/repo/target').map((task) => task.env?.CARGO_TARGET_DIR);
 * // → ['/repo/target/protocol-powerset-1', '/repo/target/protocol-powerset-2']
 */
function featurePowersetTasks(targetRoot: string): ProtocolTask[] {
  const count = FEATURE_POWERSET_PARTITIONS;
  return Array.from({ length: count }, (_, slot) => {
    const index = slot + 1;
    return {
      label: `${FEATURE_POWERSET_LABEL} (${index}/${count})`,
      cmd: [
        'cargo',
        'hack',
        'clippy',
        '-p',
        'mango-protocol',
        '--feature-powerset',
        '--all-targets',
        '--locked',
        '--partition',
        `${index}/${count}`,
        '--',
        '-D',
        'warnings',
      ],
      env: { CARGO_TARGET_DIR: join(targetRoot, `protocol-powerset-${index}`) },
      partition: { group: FEATURE_POWERSET_LABEL, index, count },
    };
  });
}

function rustCheckTasks(format: boolean, cargoHack: boolean, targetRoot: string): ProtocolTask[] {
  const tasks: ProtocolTask[] = [];
  if (format)
    tasks.push({ label: 'protocol:rustfmt', cmd: ['cargo', 'fmt', '--all', '--', '--check'] });
  tasks.push({ label: 'protocol:clippy', cmd: [...CARGO_CLIPPY] });
  tasks.push({
    label: 'protocol:doc',
    cmd: ['cargo', 'doc', '-p', 'mango-protocol', '--no-deps', '--all-features', '--locked'],
    env: { RUSTDOCFLAGS: '-D warnings' },
  });
  if (cargoHack) tasks.push(...featurePowersetTasks(targetRoot));
  return tasks;
}

/**
 * The `bun run check` protocol lanes for a flag set. Rust lanes are omitted
 * with a warning when no toolchain is present, so a contributor without Cargo
 * still gets the TypeScript half rather than a failure — unless `--rs-only`
 * asked for that half alone, which is refused rather than passing on nothing.
 * `targetRoot` is where the feature-powerset partitions put their own Cargo
 * target directories; it defaults to the checkout's (`CARGO_TARGET_DIR` or
 * `target/`).
 *
 * @example
 * protocolCheckTasks([]).map((task) => task.label);
 */
export function protocolCheckTasks(
  args: readonly string[],
  probe: ToolchainProbe = probeToolchain(),
  targetRoot: string = cargoTargetDir(ROOT_DIR, process.env)
): ProtocolTask[] {
  const { typescript, rust, format } = selectLanes(args);
  const { cargo, cargoHack } = probe;
  const tasks: ProtocolTask[] = [];

  if (typescript) tasks.push(...typescriptCheckTasks(!rust, cargo));

  if (!rust) return tasks;
  assertRustToolchain(typescript, cargo);
  if (!cargo) {
    warnNoCargo();
    return tasks;
  }

  if (!cargoHack) warnNoCargoHack();
  tasks.push(...rustCheckTasks(format, cargoHack, targetRoot));
  // The round trip drives the Rust decoder from the TypeScript encoder, so it
  // belongs to neither half alone and is skipped whenever one was narrowed out.
  if (typescript) {
    tasks.push({
      label: 'protocol:roundtrip',
      cmd: ['bun', './scripts/protocol/verify-roundtrip.ts'],
    });
  }
  return tasks;
}

/**
 * The `bun run test` protocol lanes. `MANGO_INTEROP` turns on the suites that
 * drive the Rust conformance example from TypeScript; without a toolchain they
 * skip themselves, which is what keeps a `--ts-only` run toolchain-free. As in
 * `protocolCheckTasks`, `--rs-only` on a machine without Cargo is refused.
 *
 * @example
 * protocolTestTasks(['--ts-only'], []).map((task) => task.label);
 */
export function protocolTestTasks(
  args: readonly string[],
  bunTestArgs: readonly string[] = [],
  probe: ToolchainProbe = probeToolchain()
): ProtocolTask[] {
  const { typescript, rust } = selectLanes(args);
  const { cargo } = probe;
  const tasks: ProtocolTask[] = [];

  if (typescript) {
    tasks.push({
      label: 'protocol:bun-test',
      cmd: ['bun', 'test', '--timeout', '15000', 'packages/protocol', ...bunTestArgs],
      ...(rust && cargo ? { env: { MANGO_INTEROP: '1' } } : {}),
    });
  }

  if (!rust) return tasks;
  assertRustToolchain(typescript, cargo);
  if (!cargo) {
    warnNoCargo();
    return tasks;
  }

  tasks.push({
    label: 'protocol:cargo-test',
    cmd: ['cargo', 'test', '-p', 'mango-protocol', '--all-targets', '--all-features', '--locked'],
  });
  tasks.push({
    label: 'protocol:cargo-test-doc',
    cmd: ['cargo', 'test', '-p', 'mango-protocol', '--doc', '--all-features', '--locked'],
  });
  return tasks;
}
