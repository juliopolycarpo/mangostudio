import { describe, expect, test } from 'bun:test';
import { join, sep } from 'node:path';
import { ROOT_DIR } from '../lib/config';
import { runProtocolTasks, unsettledPartitions } from '../protocol/run-tasks';
import { type ProtocolTask, protocolCheckTasks, type ToolchainProbe } from '../protocol/tasks';
import { hasCargoHack } from '../protocol/toolchain';
import {
  coverageProblems,
  FakeCargoHack,
  featurePowerset,
  NO_FEATURES,
  type RecordedHackRun,
} from './support/protocol-powerset-fakes';
import { readText } from './support/read-text';

// `bun run protocol:check` runs the 36 feature configurations of `mango-protocol`
// as disjoint cargo-hack partitions, each in a Cargo target directory of its own,
// and fails unless every partition ran and passed. These tests pin the three ways
// that quietly stops being true: a configuration that no partition runs, one that
// two run, and a partition that is missing, failed or cancelled behind a green
// summary. No test starts a compiler; `FakeCargoHack` records what it was asked.

const INSTALLED: ToolchainProbe = { cargo: true, cargoHack: true };
const TARGET_ROOT = join('/repo', 'target');
const POWERSET_LABEL = 'protocol:feature-powerset';

const manifest = Bun.TOML.parse(readText('crates/mango-protocol/Cargo.toml')) as {
  features: Record<string, string[]>;
};
const CONFIGURATIONS = featurePowerset(manifest.features);

const powersetTasks = (): ProtocolTask[] =>
  protocolCheckTasks(['--rs-only'], INSTALLED, TARGET_ROOT).filter((task) =>
    task.label.startsWith(POWERSET_LABEL)
  );

const withoutPartition = (cmd: readonly string[]): string[] => {
  const at = cmd.indexOf('--partition');
  return at === -1 ? [...cmd] : [...cmd.slice(0, at), ...cmd.slice(at + 2)];
};

const run = (task: ProtocolTask, configurations: readonly string[]): RecordedHackRun => ({
  label: task.label,
  partition: undefined,
  targetDir: task.env?.CARGO_TARGET_DIR,
  configurations,
});

describe('the feature powerset the partitions must cover', () => {
  test('is the 36 configurations the gate has always run', () => {
    expect(
      CONFIGURATIONS.length,
      `expected feature configurations of mango-protocol: 36 | received: ${CONFIGURATIONS.length} (${CONFIGURATIONS.join(' ; ')})`
    ).toBe(36);
  });

  // The model above stands in for cargo-hack in the tests below. Where cargo-hack
  // is installed (it lists the commands without compiling anything), the model is
  // held to its answer, so a feature added to the crate cannot leave both stale.
  test.skipIf(!hasCargoHack())('matches the list cargo-hack itself prints', () => {
    const listed = Bun.spawnSync(
      [
        ...['cargo', 'hack', 'clippy', '-p', 'mango-protocol', '--feature-powerset'],
        ...['--all-targets', '--locked', '--print-command-list', '--', '-D', 'warnings'],
      ],
      { cwd: ROOT_DIR }
    );
    expect(
      listed.exitCode,
      `expected cargo hack --print-command-list to exit 0 | received: ${listed.exitCode}: ${listed.stderr}`
    ).toBe(0);
    const configurations = listed.stdout
      .toString()
      .split('\n')
      .filter((line) => line.startsWith('cargo clippy'))
      .map(
        (line) => / --features (\S+)/.exec(line)?.[1]?.split(',').sort().join(',') ?? NO_FEATURES
      );
    const cargoHackRun: RecordedHackRun = {
      label: 'cargo hack --print-command-list',
      partition: undefined,
      targetDir: undefined,
      configurations,
    };
    expect(
      coverageProblems(CONFIGURATIONS, [cargoHackRun]),
      'cargo-hack and the model disagree'
    ).toBeNull();
  });
});

describe('the feature-powerset partitions', () => {
  test('are two commands, each told which slice of the powerset it owns', () => {
    const labels = powersetTasks().map((task) => task.label);
    expect(
      labels,
      `expected feature-powerset partitions: 2 | received: ${labels.length} (${labels.join(', ')})`
    ).toEqual([`${POWERSET_LABEL} (1/2)`, `${POWERSET_LABEL} (2/2)`]);
    const slices = powersetTasks().map((task) => task.cmd[task.cmd.indexOf('--partition') + 1]);
    expect(
      slices,
      `expected --partition values: 1/2, 2/2 | received: ${slices.join(', ')}`
    ).toEqual(['1/2', '2/2']);
  });

  test('run every one of the 36 configurations exactly once between them', async () => {
    const cargo = new FakeCargoHack(CONFIGURATIONS);
    await runProtocolTasks(powersetTasks(), cargo.run, () => undefined);
    expect(
      coverageProblems(CONFIGURATIONS, cargo.runs),
      'partitions do not cover the powerset'
    ).toBeNull();
  });

  test('keep every flag the single command had, so no coverage moved out of the gate', () => {
    for (const task of powersetTasks()) {
      expect(withoutPartition(task.cmd).join(' '), task.label).toBe(
        'cargo hack clippy -p mango-protocol --feature-powerset --all-targets --locked -- -D warnings'
      );
    }
  });

  test('each build into a target directory of its own under the target root', () => {
    const dirs = powersetTasks().map((task) => task.env?.CARGO_TARGET_DIR);
    expect(
      new Set(dirs).size,
      `expected one CARGO_TARGET_DIR per partition, 2 distinct | received: ${JSON.stringify(dirs)}`
    ).toBe(2);
    for (const dir of dirs) {
      expect(
        dir?.startsWith(`${TARGET_ROOT}${sep}`),
        `expected a directory under ${TARGET_ROOT} | received: ${dir}`
      ).toBe(true);
    }
  });

  test('follow a moved target root, and leave the other cargo lanes on the default target', () => {
    const moved = join('/mnt', 'cargo');
    const tasks = protocolCheckTasks(['--rs-only'], INSTALLED, moved);
    const dirs = tasks
      .filter((task) => task.label.startsWith(POWERSET_LABEL))
      .map((task) => task.env?.CARGO_TARGET_DIR);
    expect(dirs, `expected partitions under ${moved}`).toEqual([
      join(moved, 'protocol-powerset-1'),
      join(moved, 'protocol-powerset-2'),
    ]);
    for (const task of tasks.filter((entry) => !entry.label.startsWith(POWERSET_LABEL))) {
      expect(
        task.env?.CARGO_TARGET_DIR,
        `${task.label} must share the default target`
      ).toBeUndefined();
    }
  });

  // The coverage assertion above is only worth having if it fails when a
  // partition is wrong, so it is shown the two ways a partition goes wrong.
  test('coverage check names the configurations a dropped partition leaves unrun', () => {
    const [first] = powersetTasks();
    const problems = coverageProblems(CONFIGURATIONS, [
      run(first as ProtocolTask, CONFIGURATIONS.slice(0, 18)),
    ]);
    expect(problems).toContain('expected 36 configurations, each run once');
    expect(problems).toContain(`missing: ${CONFIGURATIONS.slice(18).join(' ; ')}`);
    expect(problems).toContain('duplicated: none');
  });

  test('coverage check names the configurations two overlapping partitions both run', () => {
    const [first] = powersetTasks();
    const problems = coverageProblems(CONFIGURATIONS, [
      run(first as ProtocolTask, CONFIGURATIONS.slice(0, 20)),
      run(first as ProtocolTask, CONFIGURATIONS.slice(18)),
    ]);
    expect(problems).toContain(`duplicated: ${CONFIGURATIONS.slice(18, 20).join(' ; ')}`);
    expect(problems).toContain('missing: none');
  });
});

describe('the gate over the feature-powerset partitions', () => {
  const exitCodes = (results: ReadonlyArray<{ label: string; exitCode: number }>) =>
    Object.fromEntries(results.map((result) => [result.label, result.exitCode]));

  test('starts both partitions before either one finishes', async () => {
    const cargo = new FakeCargoHack(CONFIGURATIONS);
    await runProtocolTasks(powersetTasks(), cargo.run, () => undefined);
    expect(
      cargo.maxInFlight,
      `expected partitions running at the same time: 2 | received: ${cargo.maxInFlight}`
    ).toBe(2);
  });

  test('passes when both partitions exit 0', async () => {
    const cargo = new FakeCargoHack(CONFIGURATIONS);
    const results = await runProtocolTasks(powersetTasks(), cargo.run, () => undefined);
    expect(exitCodes(results)).toEqual({
      [`${POWERSET_LABEL} (1/2)`]: 0,
      [`${POWERSET_LABEL} (2/2)`]: 0,
    });
  });

  test('fails when a partition fails, and the other partition still runs to its end', async () => {
    const cargo = new FakeCargoHack(CONFIGURATIONS, {
      exitCodes: { [`${POWERSET_LABEL} (1/2)`]: 101 },
    });
    const results = await runProtocolTasks(powersetTasks(), cargo.run, () => undefined);
    expect(exitCodes(results)[`${POWERSET_LABEL} (1/2)`]).toBe(101);
    expect(
      cargo.runs.map((entry) => entry.label),
      'expected the passing partition to finish and print its diagnostics'
    ).toContain(`${POWERSET_LABEL} (2/2)`);
  });

  test('fails when a partition cannot be started, and says which one', async () => {
    const reported: string[] = [];
    const cargo = new FakeCargoHack(CONFIGURATIONS, {
      neverStarts: new Set([`${POWERSET_LABEL} (2/2)`]),
    });
    const results = await runProtocolTasks(powersetTasks(), cargo.run, (message) =>
      reported.push(message)
    );
    expect(exitCodes(results)[`${POWERSET_LABEL} (2/2)`]).not.toBe(0);
    expect(reported.join('\n')).toContain(
      `expected ${POWERSET_LABEL} (2/2) to start | received: spawn cargo ENOENT`
    );
    expect(cargo.runs.map((entry) => entry.label)).toContain(`${POWERSET_LABEL} (1/2)`);
  });

  test('fails when a partition is cancelled before it exits', async () => {
    const cargo = new FakeCargoHack(CONFIGURATIONS, {
      exitCodes: { [`${POWERSET_LABEL} (2/2)`]: 143 },
    });
    const results = await runProtocolTasks(powersetTasks(), cargo.run, () => undefined);
    expect(exitCodes(results)[`${POWERSET_LABEL} (2/2)`]).toBe(143);
  });

  test('fails when the task list holds only one of the two partitions', async () => {
    const reported: string[] = [];
    const [first] = powersetTasks();
    const cargo = new FakeCargoHack(CONFIGURATIONS);
    const results = await runProtocolTasks([first as ProtocolTask], cargo.run, (message) =>
      reported.push(message)
    );
    expect(
      exitCodes(results)[`${POWERSET_LABEL} (2/2)`],
      'expected a failing result for the partition that never ran'
    ).toBe(1);
    expect(reported).toEqual([
      `expected ${POWERSET_LABEL} (2/2) to run and exit 0 | received: no such task`,
    ]);
  });

  test('a task outside any partition group is passed through untouched', async () => {
    const plain: ProtocolTask = { label: 'protocol:doc', cmd: ['cargo', 'doc'] };
    const cargo = new FakeCargoHack(CONFIGURATIONS);
    const results = await runProtocolTasks([plain], cargo.run, () => undefined);
    expect(exitCodes(results)).toEqual({ 'protocol:doc': 0 });
  });

  test('unsettledPartitions reports a partition with no result as such', () => {
    const tasks = powersetTasks();
    const [first] = tasks;
    const unsettled = unsettledPartitions(tasks, [
      { label: (first as ProtocolTask).label, exitCode: 0, duration: 0 },
    ]);
    expect(unsettled).toEqual([{ label: `${POWERSET_LABEL} (2/2)`, received: 'no result' }]);
  });
});
