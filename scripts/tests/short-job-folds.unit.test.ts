import { describe, expect, test } from 'bun:test';

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
});
