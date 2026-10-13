import { describe, expect, test } from 'bun:test';

import { evaluateGate } from '../ci/evaluate-gate';
import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractJobBlocks,
  extractStepBlocks,
  parseNeedsList,
} from './support/workflow-blocks';

const EXPR = '$' + '{{';
const FUZZ_METADATA =
  'cargo metadata --manifest-path crates/mango-protocol/fuzz/Cargo.toml --locked --all-features --format-version 1 > /dev/null';

function commandStep(workflow: string, job: string, command: string): string {
  const step = extractStepBlocks(extractJobBlock(workflow, job)).find((entry) =>
    entry.includes(`run: ${command}\n`)
  );
  expect(step, `${job} must retain ${command}`).toBeDefined();
  return step ?? '';
}

function simulate(block: string, os: string, failure?: string, cancelled = false) {
  const outcomes: Record<string, string> = {};
  const commands: string[] = [];
  let failed = false;
  for (const step of extractStepBlocks(block)) {
    const id = /(?:^|\n)\s*(?:- )?id: ([\w-]+)/.exec(step)?.[1];
    const command = /(?:^|\n)\s*(?:- )?run: (.+)/.exec(step)?.[1];
    const expression = /(?:^|\n)\s*(?:- )?if: (.+)/.exec(step)?.[1];
    let runs: boolean = !cancelled && !failed;
    if (expression) {
      const condition = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
      runs = condition.split(' && ').every((atom) => {
        if (atom === '!cancelled()') return !cancelled;
        const outcome = /^steps\.([\w-]+)\.outcome == 'success'$/.exec(atom);
        if (outcome) return outcomes[outcome[1] as string] === 'success';
        const host = /^matrix\.os (!=|==) '([^']+)'$/.exec(atom);
        if (host) return (os === host[2]) === (host[1] === '==');
        throw new Error(`Unknown folded-step condition: ${atom}`);
      });
      if (!condition.includes('cancelled()')) runs &&= !failed && !cancelled;
    }
    const outcome: 'success' | 'failure' | 'skipped' = !runs
      ? 'skipped'
      : failure !== undefined && (command === failure || id === failure)
        ? 'failure'
        : 'success';
    if (runs && command) commands.push(command);
    if (id) outcomes[id] = outcome;
    failed ||= outcome === 'failure';
  }
  return {
    commands,
    result: cancelled
      ? ('cancelled' as const)
      : failed
        ? ('failure' as const)
        : ('success' as const),
  };
}

describe('short-job fold command and failure coverage', () => {
  const protocol = readText('.github/workflows/protocol-ci.yml');
  const cargo = readText('.github/workflows/cargo-shim.yml');

  test('the TypeScript host retains package validation after an independent check failure', () => {
    const job = extractJobBlock(protocol, 'typescript');
    expect(job).not.toMatch(/rustup|cargo |rust-cache/);
    for (const command of [
      'bun run protocol:check --ts-only',
      'bun run protocol:test --ts-only',
      'bun ./scripts/protocol/verify-package.ts',
    ]) {
      const step = commandStep(protocol, 'typescript', command);
      expect(step).toContain(`if: ${EXPR} !cancelled() && steps.install.outcome == 'success' }}`);
      expect(step).not.toContain('continue-on-error');
    }
    expect(extractJobBlock(protocol, 'package')).toBe('');
  });

  test('macOS and Windows transport tests survive a failed peer compile while interop retains its prerequisite', () => {
    const job = extractJobBlock(protocol, 'interop');
    expect(job).toContain('os: [ubuntu-latest, macos-latest, windows-latest]');
    const transport = commandStep(protocol, 'interop', 'bun run protocol:test --ts-only');
    expect(transport).toContain(
      `if: ${EXPR} !cancelled() && steps.install.outcome == 'success' && matrix.os != 'ubuntu-latest' }}`
    );
    expect(transport).not.toContain('steps.peer');
    const interop = commandStep(protocol, 'interop', 'bun test packages/protocol/tests/interop');
    expect(interop).toContain(
      `if: ${EXPR} !cancelled() && steps.install.outcome == 'success' && steps.peer.outcome == 'success' }}`
    );
    expect(extractJobBlock(protocol, 'transports')).toBe('');
  });

  test('Ubuntu workspace retains complete locked fuzz resolution after independent failures', () => {
    const step = commandStep(cargo, 'workspace', FUZZ_METADATA);
    expect(step).toContain(
      `if: ${EXPR} !cancelled() && matrix.os == 'ubuntu-latest' && steps.toolchain.outcome == 'success' }}`
    );
    expect(step).not.toContain('--no-deps');
    expect(step).not.toContain('continue-on-error');
    expect(extractJobBlock(cargo, 'fuzz-workspace')).toBe('');
  });

  test('a fuzz metadata failure cannot suppress formatting or later Rust diagnostics', () => {
    const steps = extractStepBlocks(extractJobBlock(cargo, 'workspace'));
    const format = steps.findIndex((step) => step.includes('run: cargo fmt --all -- --check'));
    const metadata = steps.findIndex((step) => step.includes(`run: ${FUZZ_METADATA}`));
    expect(format).toBeGreaterThanOrEqual(0);
    expect(metadata).toBeGreaterThan(format);
    for (const step of steps
      .slice(metadata + 1)
      .filter((entry) =>
        /run: cargo (?:check|clippy|test|nextest|doc|build)\b|name: Check nextest/.test(entry)
      )) {
      expect(step, 'independent diagnostics must survive metadata failure').toContain(
        '!cancelled()'
      );
      expect(step).not.toContain('continue-on-error');
    }
  });

  test('folded jobs leave the fan-ins and the mandatory surviving owners remain', () => {
    for (const [workflow, removed, required] of [
      [
        protocol,
        ['package', 'transports'],
        ['typescript', 'interop', 'deny', 'semver-checks', 'schema-equality'],
      ],
      [
        cargo,
        ['fuzz-workspace'],
        ['workspace', 'workspace-windows-arm64', 'musl-clippy', 'runtime-home-fixture-freshness'],
      ],
    ] as const) {
      const gate = extractJobBlock(workflow, 'gate');
      for (const job of removed) {
        expect(extractJobBlocks(workflow).map((entry) => entry.job)).not.toContain(job);
        expect(parseNeedsList(gate)).not.toContain(job);
        expect(gate).not.toContain(job);
      }
      for (const job of required) expect(parseNeedsList(gate)).toContain(job);
    }
  });

  test('the folded validations retain their original host inventory', () => {
    expect(extractJobBlock(protocol, 'typescript')).toContain('runs-on: ubuntu-latest');
    for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
      const workspace = simulate(extractJobBlock(cargo, 'workspace'), os);
      expect(workspace.commands.filter((command) => command === FUZZ_METADATA)).toHaveLength(
        os === 'ubuntu-latest' ? 1 : 0
      );
      expect(workspace.commands).toContain('cargo fmt --all -- --check');
      const interop = simulate(extractJobBlock(protocol, 'interop'), os);
      expect(
        interop.commands.filter((command) => command === 'bun run protocol:test --ts-only')
      ).toHaveLength(os === 'ubuntu-latest' ? 0 : 1);
      expect(interop.commands).toContain('bun test packages/protocol/tests/interop');
    }
  });

  test('failed TypeScript checks preserve tests and package diagnostics and fail the gate', () => {
    const run = simulate(
      extractJobBlock(protocol, 'typescript'),
      'ubuntu-latest',
      'bun run protocol:check --ts-only'
    );
    expect(run.commands).toContain('bun run protocol:test --ts-only');
    expect(run.commands).toContain('bun ./scripts/protocol/verify-package.ts');
    expect(evaluateGate({ typescript: run.result }, new Set()).ok).toBe(false);
  });

  test.each(['macos-latest', 'windows-latest'])(
    'failed peer builds retain transport diagnostics on %s',
    (os) => {
      const run = simulate(extractJobBlock(protocol, 'interop'), os, 'peer');
      expect(run.commands).toContain('bun run protocol:test --ts-only');
      expect(run.commands).not.toContain('bun test packages/protocol/tests/interop');
      expect(evaluateGate({ interop: run.result }, new Set()).ok).toBe(false);
    }
  );

  test('formatting and fuzz failures retain the independent Rust commands in both directions', () => {
    for (const failure of ['cargo fmt --all -- --check', FUZZ_METADATA]) {
      const run = simulate(extractJobBlock(cargo, 'workspace'), 'ubuntu-latest', failure);
      expect(run.commands).toContain('cargo fmt --all -- --check');
      expect(run.commands).toContain(FUZZ_METADATA);
      expect(run.commands).toContain('cargo check --workspace --locked');
      expect(run.commands).toContain('cargo doc --no-deps --workspace --all-features --locked');
      expect(evaluateGate({ workspace: run.result }, new Set()).ok).toBe(false);
    }
  });

  test('failed folded-lane setup and cancellation stop dependent validations', () => {
    const typescript = extractJobBlock(protocol, 'typescript');
    const interop = extractJobBlock(protocol, 'interop');
    for (const block of [typescript, interop]) {
      const failure = simulate(block, 'windows-latest', 'install');
      expect(
        failure.commands.filter((command) =>
          /^(bun run protocol:|bun test packages\/protocol|bun \.\/scripts\/protocol\/verify-package)/.test(
            command
          )
        )
      ).toEqual([]);
      expect(failure.result).toBe('failure');
      const cancel = simulate(block, 'windows-latest', undefined, true);
      expect(cancel.commands).toEqual([]);
      expect(cancel.result).toBe('cancelled');
    }
  });
});
