import { describe, expect, test } from 'bun:test';

import { evaluateGate } from '../ci/evaluate-gate';
import baseline from './support/lane-baseline.json';
import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractJobBlocks,
  extractStepBlocks,
  parseNeedsList,
  runScriptLines,
} from './support/workflow-blocks';

// Captured from main acf8930f through the same source readers as the assertions.
// It records every Rust/protocol command, not just a representative subset.
function commandInventory(source: string): Record<string, string[]> {
  return Object.fromEntries(
    extractJobBlocks(source)
      .map(({ job, block }) => [
        job,
        runScriptLines(block)
          .map(({ text }) => text.trim().replace(/^(- )?run: /, ''))
          .filter((line) =>
            /^(cargo(?: |-|$)|bun (?:\.\/)?scripts\/(?:protocol|bench\/rust-test-inventory|ci\/rust-lanes\.ts qualify)|bun test packages\/protocol|bun run protocol:)/.test(
              line
            )
          ),
      ])
      .filter(([, commands]) => (commands as string[]).length > 0)
  );
}

// Project only the approved ownership changes. The original fixture remains
// intact, and every command and its order still has to match exactly.
function expectedCommands(name: string, source: string, original: Record<string, string[]>) {
  let expected = structuredClone(original);
  if (name === 'cargo-shim' && !extractJobBlock(source, 'fuzz-workspace')) {
    const workspace = expected.workspace as string[];
    expected.workspace = [
      workspace[0] as string,
      ...(expected['fuzz-workspace'] as string[]),
      ...workspace.slice(1),
    ];
    expected = Object.fromEntries(
      Object.entries(expected).filter(([job]) => job !== 'fuzz-workspace')
    );
  }
  if (name === 'protocol-ci' && !extractJobBlock(source, 'package')) {
    expected.typescript = [...(expected.typescript as string[]), ...(expected.package as string[])];
    expected = Object.fromEntries(Object.entries(expected).filter(([job]) => job !== 'package'));
  }
  if (name === 'protocol-ci' && !extractJobBlock(source, 'transports')) {
    const interop = expected.interop as string[];
    expected.interop = [
      interop[0] as string,
      ...(expected.transports as string[]),
      ...interop.slice(1),
    ];
    expected = Object.fromEntries(Object.entries(expected).filter(([job]) => job !== 'transports'));
  }
  if (name === 'protocol-ci') {
    // Advisories moved to the unconditional CI audit; retain every other policy.
    expected.deny = ['cargo deny check bans licenses sources'];
  }
  return expected;
}

function expectedGate(name: string, source: string, original: { needs: string[]; skips: string }) {
  const expected = structuredClone(original);
  if (name === 'ci') {
    expected.needs.splice(expected.needs.indexOf('check') + 1, 0, 'dependency-audit');
  }
  if (name === 'cargo-shim' && !extractJobBlock(source, 'fuzz-workspace')) {
    expected.needs = expected.needs.filter((job) => job !== 'fuzz-workspace');
    expected.skips = expected.skips.replace(' fuzz-workspace', '');
  }
  if (name === 'protocol-ci') {
    for (const job of ['package', 'transports']) {
      if (!extractJobBlock(source, job)) {
        expected.needs = expected.needs.filter((need) => need !== job);
        expected.skips = expected.skips.replace(` ${job}`, '');
      }
    }
  }
  if (name === 'ci' && extractJobBlock(source, 'release-dry-run')) {
    expected.needs.splice(expected.needs.indexOf('distribution') + 1, 0, 'release-dry-run');
    expected.skips = expected.skips.replace(
      "format('{0} {1} {2} {3} {4}',\n",
      "format('{0} {1} {2} {3} {4} {5}',\n            github.event_name != 'pull_request' && 'release-dry-run' || '',\n"
    );
  }
  if (name === 'ci') {
    expected.needs.splice(expected.needs.indexOf('distribution') + 1, 0, 'cross-runtimes');
  }
  if (name === 'release-dry-run' && source.includes('reuse_distribution:')) {
    expected.skips = expected.skips.replace(
      "needs.changes.outputs.release == 'false' && 'runtime'",
      "(needs.changes.outputs.release == 'false' || inputs.reuse_distribution) && 'runtime'"
    );
  }
  return expected;
}

type Outcome = 'success' | 'failure' | 'skipped';
interface Simulation {
  readonly os: string;
  readonly cancelled?: boolean;
  readonly failedCommand?: string;
  readonly failedStepId?: string;
}

// The condition subset these two jobs use. Absence of a status function adds
// GitHub's implicit success(), so a bare matrix condition reproduces the bug.
// Unknown expressions fail the regression instead of being treated as true.
function shouldRun(
  expression: string | undefined,
  priorFailed: boolean,
  steps: Record<string, Outcome>,
  simulation: Simulation
): boolean {
  if (!expression) return !priorFailed && !simulation.cancelled;
  const condition = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  if (!condition.includes('cancelled()') && (priorFailed || simulation.cancelled)) return false;
  return condition.split(' && ').every((atom) => {
    if (atom === '!cancelled()') return !simulation.cancelled;
    const outcome = /^steps\.([\w-]+)\.outcome == 'success'$/.exec(atom);
    if (outcome) return steps[outcome[1] as string] === 'success';
    const os = /^matrix\.os (!=|==) '([^']+)'$/.exec(atom);
    if (os) return (simulation.os === os[2]) === (os[1] === '==');
    throw new Error(`Unrecognized diagnostic condition: ${atom}`);
  });
}

function simulate(block: string, simulation: Simulation) {
  const steps: Record<string, Outcome> = {};
  const commands: string[] = [];
  let failed = false;
  for (const step of extractStepBlocks(block)) {
    const id = /(?:^|\n)\s*(?:- )?id: ([\w-]+)/.exec(step)?.[1];
    const condition = /(?:^|\n)\s*(?:- )?if: (.+)/.exec(step)?.[1];
    const command = /(?:^|\n)\s*(?:- )?run: (.+)/.exec(step)?.[1];
    let outcome: Outcome = 'skipped';
    if (shouldRun(condition, failed, steps, simulation)) {
      if (command) commands.push(command);
      outcome =
        (command && command === simulation.failedCommand) || (id && id === simulation.failedStepId)
          ? 'failure'
          : 'success';
    }
    if (id) steps[id] = outcome;
    failed ||= outcome === 'failure';
  }
  return {
    commands,
    steps,
    result: simulation.cancelled
      ? ('cancelled' as const)
      : failed
        ? ('failure' as const)
        : ('success' as const),
  };
}

describe('Rust and protocol workflow coverage', () => {
  test.each(Object.entries(baseline.commands))(
    '%s preserves every source-derived command',
    (name, commands) => {
      const source = readText(`.github/workflows/${name}.yml`);
      expect(commandInventory(source)).toEqual(expectedCommands(name, source, commands));
    }
  );

  test.each(Object.entries(baseline.gates))(
    '%s preserves Gate needs and allowed skips',
    (name, gate) => {
      const source = readText(`.github/workflows/${name}.yml`);
      const block = extractJobBlock(source, 'gate');
      const expected = expectedGate(name, source, gate);
      expect(parseNeedsList(block)).toEqual(expected.needs);
      const skips = /ALLOWED_SKIPS: ([\s\S]*?)(?=\n {8}#)/.exec(block)?.[1].trim();
      expect(skips).toBe(expected.skips);
    }
  );
});

describe('independent Rust and protocol diagnostics', () => {
  const protocol = extractJobBlock(readText('.github/workflows/protocol-ci.yml'), 'rust');
  const fresh = extractJobBlock(readText('.github/workflows/rust-fresh-dependencies.yml'), 'fresh');
  const schema = extractJobBlock(readText('.github/workflows/protocol-ci.yml'), 'schema-equality');

  const diagnostics = (commands: readonly string[]) =>
    commands.filter((command) => /^(cargo |bun .*scripts\/protocol\/)/.test(command));

  test('successful schema setup runs both original equality and roundtrip commands', () => {
    const run = simulate(schema, { os: 'ubuntu-latest' });
    expect(diagnostics(run.commands)).toEqual(baseline.commands['protocol-ci']['schema-equality']);
    expect(run.result).toBe('success');
  });

  test('schema equality failure still runs roundtrip and fails its aggregate gate', () => {
    const failure = 'bun ./scripts/protocol/verify-schema-equality.ts';
    const oldSchema = schema.replace(/^.*if: .*steps\.dependencies\.outcome.*\n/gm, '');
    const oldRun = simulate(oldSchema, { os: 'ubuntu-latest', failedCommand: failure });
    expect(diagnostics(oldRun.commands)).toEqual([failure]);
    const run = simulate(schema, { os: 'ubuntu-latest', failedCommand: failure });
    expect(diagnostics(run.commands)).toEqual(baseline.commands['protocol-ci']['schema-equality']);
    expect(run.result).toBe('failure');
    expect(evaluateGate({ 'schema-equality': run.result }, new Set()).ok).toBe(false);
  });

  test('successful setup runs the complete original Rust command inventory', () => {
    for (const [block, expected] of [
      [protocol, baseline.commands['protocol-ci'].rust],
      [fresh, baseline.commands['rust-fresh-dependencies'].fresh],
    ] as const) {
      const run = simulate(block, { os: 'windows-latest' });
      expect(run.commands.filter((command) => command.startsWith('cargo '))).toEqual(expected);
      expect(run.result).toBe('success');
    }
  });

  test('the former implicit success conditions suppress independent diagnostics after Clippy fails', () => {
    const oldProtocol = protocol.replace(
      /if: .*steps\.tooling\.outcome.*$/gm,
      "if: matrix.os != 'ubuntu-latest'"
    );
    const oldFresh = fresh.replace(/^.*if: .*steps\.ready\.outcome.*\n/gm, '');
    for (const [block, failure] of [
      [oldProtocol, baseline.commands['protocol-ci'].rust[0]],
      [oldFresh, baseline.commands['rust-fresh-dependencies'].fresh[0]],
    ] as const) {
      const run = simulate(block, { os: 'windows-latest', failedCommand: failure });
      expect(run.commands.filter((command) => command.startsWith('cargo '))).toEqual([failure]);
      expect(run.result).toBe('failure');
    }
  });

  test.each(['macos-latest', 'windows-latest'])(
    'protocol docs/tests still run after Clippy fails on %s',
    (os) => {
      const failure =
        'cargo hack clippy -p mango-protocol --feature-powerset --all-targets --locked -- -D warnings';
      const run = simulate(protocol, { os, failedCommand: failure });
      expect(run.commands).toContain('cargo test -p mango-protocol --doc --all-features --locked');
      expect(run.commands).toContain(
        'cargo doc -p mango-protocol --no-deps --all-features --locked'
      );
      expect(run.result).toBe('failure');
      expect(evaluateGate({ rust: run.result }, new Set()).ok).toBe(false);
    }
  );

  test('Ubuntu preserves its delegation of protocol docs to Cargo Shim', () => {
    const run = simulate(protocol, { os: 'ubuntu-latest' });
    expect(run.commands.filter((command) => /^cargo (test|doc) /.test(command))).toEqual([]);
  });

  test('a failed protocol doctest still permits the independent docs build', () => {
    const run = simulate(protocol, {
      os: 'windows-latest',
      failedCommand: 'cargo test -p mango-protocol --doc --all-features --locked',
    });
    expect(run.commands).toContain('cargo doc -p mango-protocol --no-deps --all-features --locked');
    expect(run.result).toBe('failure');
  });

  test('a failed fresh workspace test still permits doctests', () => {
    const run = simulate(fresh, {
      os: 'ubuntu-latest',
      failedCommand: 'cargo test --workspace --all-targets --all-features --locked',
    });
    expect(run.commands).toContain('cargo test --doc --workspace --all-features --locked');
    expect(run.result).toBe('failure');
  });

  test.each(['ubuntu-latest', 'macos-latest', 'windows-latest'])(
    'fresh tests/doctests still run after Clippy fails on %s',
    (os) => {
      const failure =
        'cargo clippy --workspace --all-targets --all-features --locked -- -D warnings';
      const run = simulate(fresh, { os, failedCommand: failure });
      expect(run.commands).toContain(
        'cargo test --workspace --all-targets --all-features --locked'
      );
      expect(run.commands).toContain('cargo test --doc --workspace --all-features --locked');
      expect(run.result).toBe('failure');
    }
  );

  test.each([
    ['protocol', protocol],
    ['fresh', fresh],
    ['schema', schema],
  ])('%s setup failure cannot run the diagnostics', (_name, block) => {
    const run = simulate(block, {
      os: 'macos-latest',
      failedCommand: 'rustup show active-toolchain',
    });
    expect(diagnostics(run.commands)).toEqual([]);
    expect(run.result).toBe('failure');
  });

  test.each([
    ['protocol', protocol, 'tooling'],
    ['fresh', fresh, 'ready'],
    ['schema', schema, 'dependencies'],
  ])('%s final setup failure cannot run the diagnostics', (_name, block, failedStepId) => {
    const run = simulate(block, { os: 'macos-latest', failedStepId });
    expect(diagnostics(run.commands)).toEqual([]);
    expect(run.result).toBe('failure');
  });

  test.each([
    ['protocol', protocol],
    ['fresh', fresh],
    ['schema', schema],
  ])('%s cancellation suppresses diagnostics and stays cancelled', (_name, block) => {
    const run = simulate(block, { os: 'macos-latest', cancelled: true });
    expect(run.commands).toEqual([]);
    expect(run.result).toBe('cancelled');
    expect(evaluateGate({ rust: run.result }, new Set()).ok).toBe(false);
  });
});
