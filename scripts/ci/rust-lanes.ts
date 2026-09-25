#!/usr/bin/env bun
// `.github/workflows/cargo-shim.yml`'s view of `scripts/lib/rust-lanes.ts`.
//
//   bun ./scripts/ci/rust-lanes.ts relevance <changed-files>
//     Prints `rust=<bool>` and `qualification=<bool>` lines for
//     `$GITHUB_OUTPUT`, from a file of newline-separated changed paths.
//   bun ./scripts/ci/rust-lanes.ts qualify --suite unit|integration
//     Runs the discovered Rust-backed api test files of that suite against
//     the binary MANGOSTUDIO_RUNTIME_BINARY names.
//   bun ./scripts/ci/rust-lanes.ts list
//     Prints both suites, one path per line, for a local look.
//
// Dependency-free (Node built-ins only); runs without `bun install`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  API_DIR,
  classifyChangedPaths,
  discoverQualificationTests,
  type QualificationSuites,
} from '../lib/rust-lanes';

const ROOT = join(import.meta.dir, '..', '..');

/** The `bun test` flags each suite runs with, beside its files. */
export const SUITE_FLAGS: Readonly<Record<keyof QualificationSuites, readonly string[]>> = {
  // The unit lane's one isolated worker: these files share process state.
  unit: ['--timeout', '15000', '--parallel=1'],
  integration: ['--timeout', '15000'],
};

function parseSuite(value: string | undefined): keyof QualificationSuites {
  if (value === 'unit' || value === 'integration') return value;
  throw new Error(`rust-lanes: --suite must be "unit" or "integration" | received: ${value}`);
}

function relevance(changedFiles: string | undefined): number {
  if (!changedFiles) throw new Error('rust-lanes relevance: expected a changed-files path');
  const verdict = classifyChangedPaths(readFileSync(changedFiles, 'utf8').split('\n'));
  console.log(`rust=${verdict.rust}`);
  console.log(`qualification=${verdict.qualification}`);
  return 0;
}

function qualify(args: readonly string[]): number {
  const suite = parseSuite(args[args.indexOf('--suite') + 1]);
  if (!process.env.MANGOSTUDIO_RUNTIME_BINARY?.trim()) {
    throw new Error(
      'rust-lanes qualify: MANGOSTUDIO_RUNTIME_BINARY must name the built runtime; ' +
        'without it every Rust-backed case would skip and the lane would pass having run nothing'
    );
  }
  const files = discoverQualificationTests(ROOT)[suite];
  if (files.length === 0) {
    throw new Error(`rust-lanes qualify: discovered no ${suite} test files under ${API_DIR}/tests`);
  }
  console.log(`rust-lanes: running ${files.length} ${suite} file(s):\n  ${files.join('\n  ')}`);
  const run = Bun.spawnSync(['bun', 'test', ...SUITE_FLAGS[suite], ...files], {
    cwd: join(ROOT, API_DIR),
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return run.exitCode ?? 1;
}

function list(): number {
  const suites = discoverQualificationTests(ROOT);
  for (const [suite, files] of Object.entries(suites)) {
    for (const file of files) console.log(`${suite}\t${file}`);
  }
  return 0;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'relevance') process.exit(relevance(rest[0]));
    if (command === 'qualify') process.exit(qualify(rest));
    if (command === 'list') process.exit(list());
    throw new Error(
      `rust-lanes: expected a command relevance | qualify | list | received: ${command}`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
