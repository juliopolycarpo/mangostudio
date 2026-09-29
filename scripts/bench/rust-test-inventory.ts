#!/usr/bin/env bun

/**
 * Captures and compares the Rust test inventory, so a test-target
 * consolidation or a change of runner can prove it lost no case.
 *
 * Every test carries a logical identity, `<package>/<kind>/<binary>::<test path>`,
 * independent of how the tests are packed into binaries: the cases of a
 * consolidated `tests/it/main.rs` (one `mod` per former integration-test file)
 * are folded back under the former file's name, so a before/after comparison
 * maps module paths instead of reporting every case as moved.
 *
 * Usage:
 *   bun run scripts/bench/rust-test-inventory.ts capture <out.json>
 *   bun run scripts/bench/rust-test-inventory.ts capture-nextest <out.json>
 *   bun run scripts/bench/rust-test-inventory.ts compare <before.json> <after.json>
 *   bun run scripts/bench/rust-test-inventory.ts summarize <cargo-test.log>
 *
 * `capture` builds the workspace test targets (`cargo test --no-run`) and asks
 * each libtest binary for `--list` and `--list --ignored`. `capture-nextest`
 * reads `cargo nextest list` instead, so the runner can be compared with libtest
 * on the same identities. `summarize` totals the `test result:` lines of a
 * libtest log. Doctests are out of scope (they are a separate required lane).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { info, log } from '../lib/log';

/** The integration-test binary name that folds one module per former binary. */
export const CONSOLIDATED_BINARY = 'it';

const CARGO_FLAGS = ['--workspace', '--all-targets', '--all-features', '--locked'];

/**
 * One test case: whether it is `#[ignore]`d, and how many test binaries carry it.
 * A shared support module's own tests (`support::...`) are compiled into every
 * binary that includes the module, so their count is the number of binaries;
 * consolidation lowers it, which is intended and not a lost case.
 */
export interface InventoryEntry {
  readonly ignored: boolean;
  readonly count?: number;
}

/** Logical identity to case, sorted by identity. */
export type Inventory = Readonly<Record<string, InventoryEntry>>;

/** The differences between two inventories. */
export interface InventoryDiff {
  readonly missing: readonly string[];
  readonly added: readonly string[];
  readonly ignoredChanged: readonly string[];
  /** Informational: shared-support cases compiled into fewer binaries; never a failure. */
  readonly countChanged: readonly string[];
}

/**
 * Builds the logical identity of a test case. A case of the consolidated
 * integration binary has its first path segment (the module, named after the
 * former binary) promoted to the binary name.
 *
 * @example
 * logicalId('mangostudio-runtime', 'test', 'it', 'consent::a_case')
 * // => 'mangostudio-runtime/test/consent::a_case'
 *
 * A case of a shared `support` module (`support::...`)
 * drops the binary, because the same source is compiled into each binary using it.
 */
export function logicalId(
  pkg: string,
  kind: string,
  binary: string,
  testPath: string,
  consolidated: string = CONSOLIDATED_BINARY
): string {
  if (kind === 'test') {
    if (testPath.startsWith('support::')) return `${pkg}/${kind}/${testPath}`;
  }
  if (kind === 'test' && binary === consolidated) {
    const separator = testPath.indexOf('::');
    if (separator === -1) {
      throw new Error(
        `consolidated binary "${binary}" of ${pkg} has a top-level test "${testPath}"; expected "<module>::<test>" so it maps to a former binary`
      );
    }
    return `${pkg}/${kind}/${testPath.slice(0, separator)}::${testPath.slice(separator + 2)}`;
  }
  return `${pkg}/${kind}/${binary}::${testPath}`;
}

/**
 * Parses `--list --format terse` output into test names. Benchmarks are not
 * tests and are skipped; a line of any other shape is rejected so a changed
 * libtest format cannot silently empty the inventory.
 *
 * @example
 * parseTerseList('a::b: test\nc: benchmark\n') // => ['a::b']
 */
export function parseTerseList(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    const match = /^(.*): (test|benchmark)$/.exec(line);
    if (!match) {
      throw new Error(
        `unexpected libtest --list line ${JSON.stringify(line)}; expected "<name>: test"`
      );
    }
    if (match[2] === 'test') names.push(match[1] as string);
  }
  return names;
}

/** Compares two inventories by logical identity and ignored flag. */
export function diffInventories(before: Inventory, after: Inventory): InventoryDiff {
  const missing = Object.keys(before).filter((id) => !(id in after));
  const added = Object.keys(after).filter((id) => !(id in before));
  const ignoredChanged = Object.keys(before).filter(
    (id) => id in after && before[id]?.ignored !== after[id]?.ignored
  );
  const countChanged = Object.keys(before)
    .filter((id) => id in after && (before[id]?.count ?? 1) !== (after[id]?.count ?? 1))
    .map((id) => `${id} (${before[id]?.count ?? 1} -> ${after[id]?.count ?? 1} binaries)`);
  return {
    missing: missing.sort(),
    added: added.sort(),
    ignoredChanged: ignoredChanged.sort(),
    countChanged: countChanged.sort(),
  };
}

/** Whether a diff shows no lost, new, or re-flagged case. */
export function isIdentical(diff: InventoryDiff): boolean {
  return diff.missing.length + diff.added.length + diff.ignoredChanged.length === 0;
}

/** Totals of libtest `test result:` lines. */
export interface ResultTotals {
  readonly binaries: number;
  readonly passed: number;
  readonly failed: number;
  readonly ignored: number;
  readonly filteredOut: number;
}

/**
 * Sums every `test result:` line in a libtest log.
 *
 * @example
 * summarizeResults('test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out')
 * // => { binaries: 1, passed: 3, failed: 0, ignored: 1, filteredOut: 0 }
 */
export function summarizeResults(log_: string): ResultTotals {
  const pattern =
    /test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored; \d+ measured; (\d+) filtered out/g;
  let binaries = 0;
  let passed = 0;
  let failed = 0;
  let ignored = 0;
  let filteredOut = 0;
  for (const match of log_.matchAll(pattern)) {
    binaries += 1;
    passed += Number(match[1]);
    failed += Number(match[2]);
    ignored += Number(match[3]);
    filteredOut += Number(match[4]);
  }
  return { binaries, passed, failed, ignored, filteredOut };
}

interface TestExecutable {
  readonly pkg: string;
  readonly kind: string;
  readonly binary: string;
  readonly path: string;
}

interface CargoArtifact {
  readonly reason?: string;
  readonly package_id?: string;
  readonly executable?: string | null;
  readonly profile?: { readonly test?: boolean };
  readonly target?: { readonly name: string; readonly kind: readonly string[] };
}

/**
 * The package name of a cargo `package_id`: `name ver (source)`, `source#name@ver`,
 * or `source#ver` (the name is then the last path segment of the source).
 */
export function packageName(packageId: string): string {
  const [source = '', fragment] = packageId.split('#');
  if (fragment === undefined) return packageId.split(' ')[0] as string;
  const at = fragment.lastIndexOf('@');
  if (at > 0) return fragment.slice(0, at);
  return source.split('/').pop() as string;
}

/**
 * Extracts the libtest executables from `cargo test --no-run --message-format=json`
 * output. The kind is "test" for integration tests and "lib"/"bin"/"example"
 * for unit-test harnesses, so a name shared across kinds stays distinct.
 */
export function parseTestExecutables(jsonLines: string): TestExecutable[] {
  const executables: TestExecutable[] = [];
  for (const line of jsonLines.split('\n')) {
    if (!line.startsWith('{')) continue;
    const message = JSON.parse(line) as CargoArtifact;
    if (message.reason !== 'compiler-artifact' || !message.profile?.test) continue;
    if (!message.executable || !message.target || !message.package_id) continue;
    const kind = message.target.kind[0] ?? 'unknown';
    executables.push({
      pkg: packageName(message.package_id),
      kind: kind === 'proc-macro' ? 'lib' : kind,
      binary: message.target.name,
      path: message.executable,
    });
  }
  return executables;
}

function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}; expected 0. stderr: ${result.stderr.slice(-2000)}`
    );
  }
  return result.stdout;
}

function sortInventory(entries: Record<string, InventoryEntry>): Inventory {
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function addCase(entries: Record<string, InventoryEntry>, id: string, ignored: boolean): void {
  const existing = entries[id];
  if (existing === undefined) {
    entries[id] = { ignored };
    return;
  }
  if (!id.includes('/support::')) {
    throw new Error(
      `duplicate logical test identity "${id}"; expected each case to map to one identity`
    );
  }
  entries[id] = { ignored, count: (existing.count ?? 1) + 1 };
}

function captureLibtest(): Inventory {
  const json = run('cargo', ['test', ...CARGO_FLAGS, '--no-run', '--message-format=json']);
  const entries: Record<string, InventoryEntry> = {};
  for (const exe of parseTestExecutables(json)) {
    const listed = parseTerseList(run(exe.path, ['--list', '--format', 'terse']));
    const ignored = new Set(
      parseTerseList(run(exe.path, ['--list', '--format', 'terse', '--ignored']))
    );
    for (const name of listed) {
      addCase(entries, logicalId(exe.pkg, exe.kind, exe.binary, name), ignored.has(name));
    }
  }
  return sortInventory(entries);
}

interface NextestSuite {
  readonly 'package-name': string;
  readonly kind: string;
  readonly 'binary-name': string;
  readonly testcases: Record<string, { readonly ignored?: boolean }>;
}

function captureNextest(): Inventory {
  const json = run('cargo', ['nextest', 'list', ...CARGO_FLAGS, '--message-format', 'json']);
  const suites = (JSON.parse(json) as { 'rust-suites': Record<string, NextestSuite> })[
    'rust-suites'
  ];
  const entries: Record<string, InventoryEntry> = {};
  for (const suite of Object.values(suites)) {
    for (const [name, testcase] of Object.entries(suite.testcases)) {
      const id = logicalId(suite['package-name'], suite.kind, suite['binary-name'], name);
      addCase(entries, id, testcase.ignored === true);
    }
  }
  return sortInventory(entries);
}

function readInventory(path: string): Inventory {
  return JSON.parse(readFileSync(resolve(path), 'utf8')) as Inventory;
}

function countByPackage(inventory: Inventory): string {
  const totals = new Map<string, { tests: number; ignored: number }>();
  for (const [id, entry] of Object.entries(inventory)) {
    const pkg = id.split('/')[0] as string;
    const total = totals.get(pkg) ?? { tests: 0, ignored: 0 };
    total.tests += 1;
    total.ignored += entry.ignored ? 1 : 0;
    totals.set(pkg, total);
  }
  return [...totals]
    .map(([pkg, t]) => `  ${pkg}: ${t.tests} tests, ${t.ignored} ignored`)
    .join('\n');
}

function printHelp(): never {
  log(`Usage: bun run scripts/bench/rust-test-inventory.ts <command>

  capture <out.json>           list every libtest case of the workspace
  capture-nextest <out.json>   list every case as cargo-nextest sees it
  compare <before> <after> [--allow-added a,b]
                               exit 1 when a case is missing, added, or re-flagged
  summarize <cargo-test.log>   total the "test result:" lines of a libtest log`);
  process.exit(0);
}

function main(): void {
  const args = parseArgs({ valueFlags: ['--allow-added'] });
  const [command, first, second, ...rest] = args.positional;
  if (args.flags['--help'] || command === undefined) printHelp();
  assertNoUnexpectedArguments(rest);

  if (command === 'capture' || command === 'capture-nextest') {
    if (!first) fatal(`${command} needs an output path; expected: ${command} <out.json>`);
    const inventory = command === 'capture' ? captureLibtest() : captureNextest();
    writeFileSync(resolve(first), `${JSON.stringify(inventory, null, 2)}\n`);
    info(
      `${Object.keys(inventory).length} tests written to ${first}\n${countByPackage(inventory)}`
    );
    return;
  }
  if (command === 'compare') {
    if (!first || !second)
      fatal('compare needs two inventories; expected: compare <before> <after>');
    const allowed = (args.values['--allow-added'] ?? '').split(',').filter(Boolean);
    const raw = diffInventories(readInventory(first), readInventory(second));
    const intended = raw.added.filter((id) => allowed.some((part) => id.includes(part)));
    for (const id of intended) log(`added (allowed): ${id}`);
    const diff = { ...raw, added: raw.added.filter((id) => !intended.includes(id)) };
    for (const [label, ids] of Object.entries(diff)) {
      for (const id of ids) log(`${label}: ${id}`);
    }
    if (!isIdentical(diff)) process.exit(1);
    info('inventories are identical');
    return;
  }
  if (command === 'summarize') {
    if (!first) fatal('summarize needs a log path; expected: summarize <cargo-test.log>');
    log(JSON.stringify(summarizeResults(readFileSync(resolve(first), 'utf8'))));
    return;
  }
  fatal(`unknown command "${command}"; expected capture, capture-nextest, compare, or summarize`);
}

if (import.meta.main) main();
