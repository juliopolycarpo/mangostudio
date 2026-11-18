import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT_DIR } from '../lib/config';
import { readText } from './support/read-text';
import { extractJobBlock, extractStepBlocks } from './support/workflow-blocks';

// The Rust workspace tests run under cargo-nextest, one process per test.
// What must not change is the test set and the outcomes: the same targets, the
// same features, nothing filtered, nothing retried into a pass. The one thing
// `.config/nextest.toml` may do is run the Windows PowerShell fixtures one at a
// time. Doctests stay on `cargo test --doc`, because nextest does not run them,
// and the ignored fixture generator stays on `cargo test -- --ignored`.

const WORKSPACE_TESTS =
  'cargo nextest run --workspace --all-targets --all-features --locked --retries 0';
// The runtime is three packages: the binary crate and the core and cold
// libraries it links. Windows ARM64 must test all of them.
const RUNTIME_TESTS =
  'cargo nextest run -p mangostudio-runtime -p mangostudio-runtime-core -p mangostudio-runtime-cold --all-targets --all-features --locked --retries 0';
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

const FIXTURE_GROUP = 'windows-powershell-fixture';
const USER_SERVICE_SOURCE = 'crates/mangostudio-runtime/src/cli/user_service.rs';
// How nextest names a test in the runtime's library binary: the module path
// without the crate. `user_service.rs` is mounted by `cli.rs` through
// `native_operation.rs`, not as `cli::user_service`.
const WINDOWS_TEST_PREFIX = 'cli::native_operation::user_service::windows_tests::';
// A test that touches any of these runs a real PowerShell, directly or through
// the owned fixture it spawns. `FakeTaskExec` tests match none of them.
const REAL_POWERSHELL_TOKENS = /\bProcessExec\b|\bWindowsFixture\b|\bCommand::new\b/;

interface NextestOverride {
  filter?: string;
  'test-group'?: string;
}

interface NextestConfig {
  'test-groups'?: Record<string, unknown>;
  profile?: { default?: { overrides?: NextestOverride[] } & Record<string, unknown> };
}

function parseNextestConfig(): NextestConfig {
  return Bun.TOML.parse(readText('.config/nextest.toml')) as NextestConfig;
}

/** The exact test names the group's filter lists, as nextest prints them. */
function groupedTestNames(): string[] {
  const filter = parseNextestConfig().profile?.default?.overrides?.[0]?.filter ?? '';
  return [...filter.matchAll(/test\(=([^)\s]+)\)/g)].map((match) => match[1] as string);
}

/** The text between `mod windows_tests {` and its closing brace at column 0. */
function windowsModuleBody(source: string): string {
  const open = source.indexOf('mod windows_tests {\n');
  const close = source.indexOf('\n}\n', open);
  if (open < 0 || close < 0) {
    throw new Error(
      `expected a mod windows_tests block in ${USER_SERVICE_SOURCE} | received: none`
    );
  }
  return source.slice(open, close);
}

/**
 * Each `#[test]` of the module with the text up to the next one. rustfmt puts
 * the attribute on its own line at four spaces, so the split is exact; a helper
 * defined between tests is attributed to the test above it, which fails closed.
 */
function windowsModuleTests(source: string): { name: string; body: string }[] {
  return windowsModuleBody(source)
    .split(/^ {4}#\[test\]\n/m)
    .slice(1)
    .map((body) => ({ name: /\bfn (\w+)\(/.exec(body)?.[1] ?? '<unnamed>', body }));
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
    ).toContain("!cancelled() && matrix.os != 'ubuntu-latest'");
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
      'expected the install on nextest hosts after another validation fails'
    ).toContain('!cancelled()');
    expect(install).toContain("matrix.os != 'ubuntu-latest'");
  });

  test('keeps the doctests on cargo test --doc, on Ubuntu', () => {
    const step = stepNamed(workspaceJob, 'Run doctests');

    expect(step, `expected doctest command: ${DOCTESTS} | received: none`).toBeDefined();
    expect(step).toContain(`run: ${DOCTESTS}`);
    expect(step).toContain("!cancelled() && matrix.os == 'ubuntu-latest'");
  });

  test('compares libtest and nextest test identities on nextest hosts and fails on a mismatch', () => {
    const step = stepNamed(workspaceJob, 'Check nextest runs the libtest test set');
    const received = step ?? 'no such step';

    for (const command of ['capture', 'capture-nextest', 'compare']) {
      expect(
        received,
        `expected inventory command: ${INVENTORY} ${command} | received: ${received}`
      ).toContain(`${INVENTORY} ${command}`);
    }
    expect(step).toContain("matrix.os != 'ubuntu-latest'");
    expect(step, 'expected the comparison after another validation fails').toContain(
      '!cancelled()'
    );
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
      'expected libtest --all-targets steps in cargo-shim.yml: only the isolated launcher tests'
    ).toEqual(['cargo test -p mangostudio --all-targets --locked']);
  });

  test('keeps the fixture generator on libtest --ignored', () => {
    const step = stepRunning(workspaceJob, FIXTURE_GENERATOR);

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

  test('the repository nextest config only adds the one serial PowerShell test group', () => {
    const config = parseNextestConfig();

    // An allow-list, not a deny-list: any other key (retries, default-filter,
    // slow-timeout, a second override, a profile) is a new way to weaken or
    // reshape the gate and fails here until this test says it is intended.
    expect(
      Object.keys(config).sort(),
      'expected only [profile, test-groups] in .config/nextest.toml'
    ).toEqual(['profile', 'test-groups']);
    expect(config['test-groups']).toEqual({ [FIXTURE_GROUP]: { 'max-threads': 1 } });
    expect(Object.keys(config.profile ?? {}), 'expected only the default profile').toEqual([
      'default',
    ]);
    expect(
      Object.keys(config.profile?.default ?? {}),
      'expected the default profile to hold only overrides (no retries, default-filter or skip)'
    ).toEqual(['overrides']);
    expect(config.profile?.default?.overrides).toHaveLength(1);
    expect(Object.keys(config.profile?.default?.overrides?.[0] ?? {}).sort()).toEqual([
      'filter',
      'test-group',
    ]);
    expect(config.profile?.default?.overrides?.[0]?.['test-group']).toBe(FIXTURE_GROUP);
  });
});

// Every test that starts a real PowerShell or CIM query must run in the serial
// group. nextest runs one process per test, so only a nextest test group can
// serialize them; an in-process lock would not.
describe('real PowerShell fixtures run one at a time under nextest', () => {
  const source = readText(USER_SERVICE_SOURCE);
  const realPowershellTests = windowsModuleTests(source).filter((test) =>
    REAL_POWERSHELL_TOKENS.test(test.body)
  );
  const grouped = groupedTestNames();

  test('the scan finds the module and the fixtures known today, so a broken parser cannot pass vacuously', () => {
    const names = windowsModuleTests(source).map((test) => test.name);

    expect(names, 'expected fake-backed tests in windows_tests to be scanned too').toContain(
      'restart_waits_for_installer_claim_and_then_stops_before_starting'
    );
    for (const known of [
      'fixture_receipts_distinguish_original_and_reused_process_lifetimes',
      'fixture_child_capture_excludes_lifetimes_older_than_each_parent',
      'the_runner_tree_is_terminated_after_the_runner_itself_is_gone',
      'the_slot_fallback_ends_a_shim_run_that_no_task_started',
      'owned_fixture_fallback_preserves_failure_and_independently_ends_captured_lifetimes',
    ]) {
      expect(
        realPowershellTests.map((test) => test.name),
        `expected ${known} detected as a real PowerShell test`
      ).toContain(known);
    }
    expect(
      realPowershellTests.map((test) => test.name),
      'expected a FakeTaskExec test not to count as real PowerShell'
    ).not.toContain('restart_waits_for_installer_claim_and_then_stops_before_starting');
  });

  test('the group lists exactly the tests that start real PowerShell', () => {
    const real = realPowershellTests.map((test) => test.name).sort();

    expect(
      grouped.map((name) => name.replace(WINDOWS_TEST_PREFIX, '')).sort(),
      `expected the ${FIXTURE_GROUP} filter in .config/nextest.toml to list the tests that use ProcessExec or WindowsFixture in ${USER_SERVICE_SOURCE}: ${real.join(', ')}`
    ).toEqual(real);
    for (const name of grouped) {
      expect(name, `expected ${name} under ${WINDOWS_TEST_PREFIX}`).toStartWith(
        WINDOWS_TEST_PREFIX
      );
    }
  });

  test('the filter is the package plus an exact-name list and nothing else', () => {
    const filter = (parseNextestConfig().profile?.default?.overrides?.[0]?.filter ?? '').replace(
      /\s+/g,
      ''
    );
    const names = grouped.length;
    const expected = `package(mangostudio-runtime)&(${Array(names).fill('test(=NAME)').join('|')})`;

    expect(
      filter.replace(/test\(=[^)]+\)/g, 'test(=NAME)'),
      `expected: ${expected} | received: ${filter}`
    ).toBe(expected);
  });

  test('the module path in the filter is the path the test binary reports', () => {
    // nextest names a library test by its module path without the crate:
    // lib.rs -> cli.rs (#[path]) -> native_operation.rs -> user_service.rs.
    // Linux lists the same prefix for the unix `tests` module in that file.
    expect(readText('crates/mangostudio-runtime/src/lib.rs')).toMatch(/^pub mod cli;$/m);
    expect(readText('crates/mangostudio-runtime/src/cli.rs')).toMatch(
      /^#\[path = "cli\/native_operation\.rs"\]\nmod native_operation;$/m
    );
    expect(readText('crates/mangostudio-runtime/src/cli/native_operation.rs')).toMatch(
      /^mod user_service;$/m
    );
    expect(WINDOWS_TEST_PREFIX).toBe('cli::native_operation::user_service::windows_tests::');
    expect(source).toMatch(/^#\[cfg\(all\(test, windows\)\)\]\nmod windows_tests \{$/m);
  });

  test('every PowerShell fixture query uses the one named test timeout', () => {
    const literals = [...windowsModuleBody(source).matchAll(/\.run\(&\w+,\s*([^)]*)\)/g)].map(
      (match) => match[1]
    );

    expect(
      literals,
      'expected every ProcessExec.run in windows_tests to pass FIXTURE_SCRIPT_TIMEOUT, not a literal'
    ).not.toHaveLength(0);
    for (const argument of literals) {
      expect(argument, `expected FIXTURE_SCRIPT_TIMEOUT | received: ${argument}`).toBe(
        'FIXTURE_SCRIPT_TIMEOUT'
      );
    }
  });
});

describe('the documented gate is the CI gate', () => {
  const agents = readText('AGENTS.md');
  const testing = readText('docs/reference/testing.md');
  // The workspace job also installs cargo-shear through the same action.
  const version = pinnedNextest(extractStepBlocks(workspaceJob).find(pinnedNextest));

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
