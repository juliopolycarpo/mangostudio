import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import {
  extractJobBlocks,
  extractStepBlocks,
  extractStepBlocksAtIndent,
  runScriptLines,
} from './support/workflow-blocks';
import { compositeActionFiles, workflowFiles } from './support/workflow-files';

// Incremental compilation keeps per-crate state so a rebuild of the same target
// directory can skip work. A CI job builds once, so the state only costs time and
// disk: measured on a cold target with the commands the lanes run, turning it off
// took the local runtime build from 134.5 s to 118.6 s and its target directory
// from 2.65 GB to 1.65 GB, and the nextest build from 126.7 s to 112.0 s and from
// 3.88 GB to 2.09 GB. Swatinem/rust-cache exports the same value for jobs that
// restore a cache, but not for the lanes that deliberately have none, so every
// job that compiles Rust sets it itself instead of relying on that side effect.
//
// The release profile is already non-incremental, and `--release` steps are left
// alone: setting the variable there changes no rustc argument.

// `cargo build`, `cargo +nightly fuzz run`, `cargo-zigbuild clippy` and friends.
// Subcommands that never compile (`deny`, `fmt`, `metadata`) and the ones that
// compile in a throwaway directory for a release (`install`, `publish`) are not
// listed.
const CARGO_COMPILE =
  /(?:^|[\s;&|(])cargo(?:-zigbuild)?(?:\s+\+\S+)?\s+(?:build|check|clippy|test|nextest|doc|hack|llvm-cov|zigbuild|semver-checks|fuzz|rustc|bench)\b/;

/** `CARGO_INCREMENTAL: "0"` (or an unquoted 0) on a line of its own. */
const SETS_ENV = /^\s+CARGO_INCREMENTAL:\s*["']?0["']?\s*$/m;

/** The text before the first `jobs:`, where workflow-level `env:` lives. */
function workflowHeader(text: string): string {
  return text.split(/\njobs:\n/)[0] ?? '';
}

/** Workflow-level `env:` at column 0. */
function workflowSetsEnv(text: string): boolean {
  const env = /^env:\n((?: {2}.*\n|\n)+)/m.exec(`${workflowHeader(text)}\n`)?.[1] ?? '';
  return SETS_ENV.test(env);
}

/** Job-level `env:` at indent 4, ahead of the job's steps. */
function jobSetsEnv(jobBlock: string): boolean {
  const beforeSteps = jobBlock.split(/\n {4}steps:\n/)[0] ?? '';
  const env = /^ {4}env:\n((?: {6}.*\n)+)/m.exec(`${beforeSteps}\n`)?.[1] ?? '';
  return SETS_ENV.test(env);
}

/** True for a step that compiles Rust in the dev or test profile. */
function compilesDebug(step: string): boolean {
  const script = runScriptLines(step)
    .map(({ text }) => text.trim())
    .filter((line) => !line.startsWith('#'))
    .join('\n');
  return CARGO_COMPILE.test(script) && !/--release\b/.test(script);
}

/** A step block's own `env:` (children one level below the step's keys). */
function stepSetsEnv(step: string, indent: number): boolean {
  const children = new RegExp(`^ {${indent}}CARGO_INCREMENTAL:\\s*["']?0["']?\\s*$`, 'm');
  return children.test(step);
}

interface CargoJob {
  readonly file: string;
  readonly name: string;
  readonly workflowSets: boolean;
  readonly jobSets: boolean;
  readonly compilingSteps: readonly string[];
}

/** Every job in every workflow with at least one step that compiles Rust in a debug profile. */
function cargoJobs(): CargoJob[] {
  return workflowFiles().flatMap((file) => {
    const text = readText(file);
    return extractJobBlocks(text)
      .map(({ job, block }) => ({
        file,
        name: job,
        workflowSets: workflowSetsEnv(text),
        jobSets: jobSetsEnv(block),
        compilingSteps: extractStepBlocks(block).filter(compilesDebug),
      }))
      .filter((job) => job.compilingSteps.length > 0);
  });
}

describe('CARGO_INCREMENTAL in CI', () => {
  test('the derivation finds the jobs it is meant to guard', () => {
    // A canary against the pattern rotting: if no job were found the checks
    // below would pass for the wrong reason.
    const names = cargoJobs().map(({ file, name }) => `${file.split('/').pop()}:${name}`);
    for (const expected of [
      'cargo-shim.yml:workspace',
      'cargo-shim.yml:workspace-msrv',
      'cargo-shim.yml:workspace-windows-arm64',
      'protocol-ci.yml:rust',
      'rust-coverage.yml:coverage',
      'rust-fresh-dependencies.yml:fresh',
    ]) {
      expect(names, `expected the derivation to find ${expected} | received: ${names}`).toContain(
        expected
      );
    }
  });

  test('every job that compiles Rust in a debug profile sets CARGO_INCREMENTAL to 0', () => {
    const missing = cargoJobs()
      .filter(
        (job) =>
          !job.workflowSets && !job.jobSets && job.compilingSteps.some((s) => !stepSetsEnv(s, 10))
      )
      .map(({ file, name }) => `${file} job '${name}'`);

    expect(
      missing,
      `expected CARGO_INCREMENTAL: "0" in the workflow, job or step env of every job that compiles Rust in a debug profile | received without it: ${missing.join('; ')}`
    ).toEqual([]);
  });

  test('every composite action that compiles Rust sets CARGO_INCREMENTAL to 0 on the step', () => {
    const missing: string[] = [];
    let compiling = 0;
    for (const file of compositeActionFiles()) {
      for (const step of extractStepBlocksAtIndent(readText(file), 4).filter(compilesDebug)) {
        compiling += 1;
        if (!stepSetsEnv(step, 8)) {
          missing.push(`${file} step '${/name:\s*(.+)/.exec(step)?.[1] ?? step.split('\n')[0]}'`);
        }
      }
    }

    // Canary for the composite derivation: the Local runtime build is one.
    expect(
      compiling,
      'expected at least one compiling composite step | received: none'
    ).toBeGreaterThan(0);
    expect(
      missing,
      `expected CARGO_INCREMENTAL: "0" on every composite step that compiles Rust in a debug profile | received without it: ${missing.join('; ')}`
    ).toEqual([]);
  });
});
