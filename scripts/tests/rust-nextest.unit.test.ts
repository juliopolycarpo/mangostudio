import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';
import { extractJobBlock, extractStepBlocks } from './support/workflow-blocks';

// The Rust workspace tests run under cargo-nextest, one process per test.
// What must not change is the test set and the outcomes: the same targets, the
// same features, nothing filtered, nothing retried into a pass. Doctests stay
// on `cargo test --doc`, because nextest does not run them, and the ignored
// fixture generator stays on `cargo test -- --ignored`.

const WORKSPACE_TESTS =
  'cargo nextest run --workspace --all-targets --all-features --locked --retries 0';
const RUNTIME_TESTS =
  'cargo nextest run -p mangostudio-runtime --all-targets --all-features --locked --retries 0';
const DOCTESTS = 'cargo test --doc --workspace --all-features --locked';
const FIXTURE_GENERATOR =
  'cargo test -p mangostudio-runtime --test generate_rust_fixture --locked -- --ignored';
const INVENTORY = 'bun scripts/bench/rust-test-inventory.ts';

const shim = readText('.github/workflows/cargo-shim.yml');
const workspaceJob = extractJobBlock(shim, 'workspace');
const arm64Job = extractJobBlock(shim, 'workspace-windows-arm64');

function stepNamed(job: string, name: string): string | undefined {
  return extractStepBlocks(job).find((step) => step.includes(`name: ${name}`));
}

function stepRunning(job: string, command: string): string | undefined {
  return extractStepBlocks(job).find((step) => step.includes(command));
}

const INSTALL_NEXTEST =
  /taiki-e\/install-action@[0-9a-f]{40} # v\d+\.\d+\.\d+\n\s+with:\n\s+tool: cargo-nextest@(\d+\.\d+\.\d+)\n/;

function pinnedNextest(step: string | undefined): string | undefined {
  return INSTALL_NEXTEST.exec(step ?? '')?.[1];
}

describe('workspace tests run under nextest in Cargo Shim', () => {
  test('macOS and Windows run the nextest gate with the libtest flags and no retries', () => {
    const step = stepNamed(workspaceJob, 'Run tests');
    const received = step?.match(/run: (.*)/)?.[1];

    expect(
      received,
      `expected workspace test command: ${WORKSPACE_TESTS} | received: ${received}`
    ).toBe(WORKSPACE_TESTS);
    expect(
      step,
      'expected the step to skip ubuntu-latest: it runs under rust-coverage.yml'
    ).toContain("if: matrix.os != 'ubuntu-latest'");
  });

  test('installs cargo-nextest at an exact version through the SHA-pinned install action, before first use', () => {
    const steps = extractStepBlocks(workspaceJob);
    const install = steps.find((step) => pinnedNextest(step));
    const firstUse = steps.findIndex(
      (step) =>
        step.includes('name: Run tests') ||
        step.includes('name: Check nextest runs the libtest test set')
    );

    expect(
      pinnedNextest(install),
      'expected a taiki-e/install-action@<sha> step with tool: cargo-nextest@<x.y.z> | received: none'
    ).toBeDefined();
    expect(
      steps.indexOf(install ?? ''),
      'expected the nextest install before the first step that uses it'
    ).toBeLessThan(firstUse);
    expect(
      install,
      'expected an unconditional install: the parity step runs on every OS'
    ).not.toContain('if:');
  });

  test('keeps the doctests on cargo test --doc, on Ubuntu', () => {
    const step = stepNamed(workspaceJob, 'Run doctests');

    expect(step, `expected doctest command: ${DOCTESTS} | received: none`).toBeDefined();
    expect(step).toContain(`run: ${DOCTESTS}`);
    expect(step).toContain("if: matrix.os == 'ubuntu-latest'");
  });

  test('compares libtest and nextest test identities on every OS and fails on a mismatch', () => {
    const step = stepNamed(workspaceJob, 'Check nextest runs the libtest test set');
    const received = step ?? 'no such step';

    for (const command of ['capture', 'capture-nextest', 'compare']) {
      expect(
        received,
        `expected inventory command: ${INVENTORY} ${command} | received: ${received}`
      ).toContain(`${INVENTORY} ${command}`);
    }
    expect(step, 'expected the comparison to run on every OS').not.toContain('if:');
    expect(step, 'expected a comparison whose failure fails the job').not.toContain(
      'continue-on-error'
    );
    expect(step, 'expected a comparison whose failure fails the job').not.toMatch(/\|\| *(true|:)/);
    expect(step, 'expected bash, so $RUNNER_TEMP expands on Windows').toContain('shell: bash');
  });

  test('moves no cargo test --workspace --all-targets step back into the workflow', () => {
    const received = shim.match(/cargo test [^\n]*--all-targets[^\n]*/g) ?? [];

    expect(
      received,
      'expected libtest --all-targets steps in cargo-shim.yml: only the launcher floor'
    ).toEqual(['cargo test -p mangostudio --all-targets --locked']);
  });

  test('keeps the fixture generator on libtest --ignored', () => {
    const step = stepRunning(
      extractJobBlock(shim, 'runtime-home-fixture-freshness'),
      FIXTURE_GENERATOR
    );

    expect(
      step,
      `expected fixture generator command: ${FIXTURE_GENERATOR} | received: none`
    ).toBeDefined();
  });
});

describe('Windows ARM64 runtime tests run under nextest', () => {
  test('runs the runtime package under nextest with the same flags and no retries', () => {
    const step = stepRunning(arm64Job, 'cargo nextest');
    const received = step?.match(/run: (.*)/)?.[1];

    expect(
      received,
      `expected runtime test command: ${RUNTIME_TESTS} | received: ${received}`
    ).toBe(RUNTIME_TESTS);
  });

  test('installs the same cargo-nextest version as the workspace job', () => {
    const installed = extractStepBlocks(arm64Job).map(pinnedNextest).find(Boolean);
    const workspace = extractStepBlocks(workspaceJob).map(pinnedNextest).find(Boolean);

    expect(
      workspace,
      'expected a pinned cargo-nextest in the workspace job | received: none'
    ).toBeDefined();
    expect(installed, `expected cargo-nextest@${workspace} | received: ${installed}`).toBe(
      workspace
    );
  });
});

describe('nextest cannot be weakened outside the command line', () => {
  const workflows = readdirSync(join(ROOT_DIR, '.github/workflows')).filter((file) =>
    file.endsWith('.yml')
  );

  test.each(workflows)('%s retries nothing and sets no nextest environment', (file) => {
    const text = readText(`.github/workflows/${file}`);
    const commands = text.match(/cargo nextest run[^\n]*/g) ?? [];

    for (const command of commands) {
      expect(command, `expected --retries 0 in ${file} | received: ${command}`).toContain(
        '--retries 0'
      );
    }
    expect(text, `expected no NEXTEST_* override in ${file}`).not.toMatch(/NEXTEST_/);
  });

  test('there is no repository nextest config that retries or filters tests', () => {
    const config = join(ROOT_DIR, '.config/nextest.toml');
    const text = existsSync(config) ? readText('.config/nextest.toml') : '';

    expect(
      text,
      'expected no retries, default-filter or overrides in .config/nextest.toml'
    ).not.toMatch(/retries|default-filter|overrides|\bskip\b/);
  });
});

describe('the documented gate is the CI gate', () => {
  const agents = readText('AGENTS.md');
  const testing = readText('docs/reference/testing.md');
  const version = pinnedNextest(stepRunning(workspaceJob, 'taiki-e/install-action'));

  test('AGENTS.md names the nextest command and keeps the doctest command', () => {
    const received = agents.match(/cargo (?:nextest run|test)[^`]*--workspace[^`]*/g);

    expect(
      received,
      `expected AGENTS.md to list ${WORKSPACE_TESTS} | received: ${received}`
    ).toContain(WORKSPACE_TESTS);
    expect(received).toContain(DOCTESTS);
  });

  test('the testing reference installs the version the workflow pins', () => {
    const command = `cargo install cargo-nextest --locked --version ${version}`;

    expect(testing, `expected docs/reference/testing.md to contain: ${command}`).toContain(command);
  });
});
