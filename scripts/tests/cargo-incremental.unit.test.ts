import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';
import {
  extractJobBlocks,
  extractStepBlocks,
  extractStepBlocksAtIndent,
  runScriptLines,
} from './support/workflow-blocks';
import { compositeActionFiles, workflowFiles } from './support/workflow-files';

type Environment = Readonly<Record<string, unknown>>;

interface CargoStep {
  readonly name?: string;
  readonly run?: string;
  readonly env?: Environment;
}

interface CargoJob {
  readonly file: string;
  readonly name: string;
  readonly workflowEnv?: Environment;
  readonly env?: Environment;
  readonly compilingSteps: readonly CargoStep[];
}

// Commands that compile Rust. Release-only package installation/publication and
// non-compiling commands such as fmt/metadata/deny are outside this policy.
const CARGO_COMPILE =
  /(?:^|[\s;&|(])cargo(?:-zigbuild)?(?:\s+\+\S+)?\s+(?:build|check|clippy|test|nextest|doc|hack|llvm-cov|zigbuild|semver-checks|fuzz|rustc|bench)\b/;

/** Check each shell command so a release command cannot exempt a debug sibling. */
function compilesDebug(step: CargoStep): boolean {
  const commands = (step.run ?? '').replace(/(?:\\|`)\r?\n/g, ' ').split(/\r?\n|&&|\|\||[;|]/);
  return commands.some((command) => {
    const cargoArgs = command.replace(/#.*$/, '').split(/\s+--(?:\s|$)/)[0];
    return CARGO_COMPILE.test(cargoArgs) && !/--release\b/.test(cargoArgs);
  });
}

/** Resolve the narrowest declared env mapping; an invalid override fails closed. */
function incrementalSetting(...environments: readonly (Environment | undefined)[]): unknown {
  return environments.find((env) => env && Object.hasOwn(env, 'CARGO_INCREMENTAL'))
    ?.CARGO_INCREMENTAL;
}

/** Only the literal string or YAML number zero disables incremental compilation. */
function setsZero(...environments: readonly (Environment | undefined)[]): boolean {
  const setting = incrementalSetting(...environments);
  return setting === '0' || setting === 0;
}

/** Parse only the env mapping at this YAML key depth, excluding run script text. */
function environmentAt(source: string, indent: number): Environment | undefined {
  const lines = source.split('\n');
  const marker = new RegExp(`^ {${indent}}env:`);
  const start = lines.findIndex((line) => marker.test(line));
  if (start < 0) return undefined;
  const remaining = lines.slice(start + 1);
  const end = remaining.findIndex(
    (line) => line.trim() !== '' && !line.trimStart().startsWith('#') && line.search(/\S/) <= indent
  );
  const block = [lines[start].slice(indent), ...remaining.slice(0, end < 0 ? undefined : end)].join(
    '\n'
  );
  return (Bun.YAML.parse(block) as { env?: Environment }).env;
}

/** Preserve the existing script extractor and read the step's own env mapping. */
function stepInfo(block: string): CargoStep {
  const indent = (block.match(/^ */)?.[0].length ?? 0) + 2;
  return {
    name: /name:\s*(.+)/.exec(block)?.[1],
    run: runScriptLines(block)
      .map(({ text }) => text.trim())
      .join('\n'),
    env: environmentAt(block.replace(/^( *)- /, '$1  '), indent),
  };
}

/** Derive compiling jobs and their env mappings without parsing unrelated matrix expressions. */
function cargoJobs(file: string, text: string): CargoJob[] {
  const workflowEnv = environmentAt(text.split(/\njobs:/)[0], 0);
  return extractJobBlocks(`\n${text}`)
    .map(({ job, block }) => ({
      file,
      name: job,
      workflowEnv,
      env: environmentAt(block.split(/\n {4}steps:/)[0], 4),
      compilingSteps: extractStepBlocks(block).map(stepInfo).filter(compilesDebug),
    }))
    .filter((job) => job.compilingSteps.length > 0);
}

describe('Cargo compilation detection', () => {
  const cases: readonly [string, string | undefined, boolean][] = [
    ['debug', 'cargo check --locked', true],
    ['release only', 'cargo build --release --locked', false],
    ['mixed lines', 'cargo build --locked\ncargo build --release --locked', true],
    ['mixed shell commands', 'cargo build --release && cargo test --locked', true],
    ['continued release', 'cargo build \\\n  --release --locked', false],
    ['continued PowerShell release', 'cargo build `\n  --release --locked', false],
    ['debug before continued release', 'cargo check\ncargo build \\\n  --release', true],
    ['commented release flag', 'cargo check # --release', true],
    ['commented cargo command', '# cargo check\ncargo fmt --all', false],
    ['test program argument', 'cargo test -- --release', true],
    ['toolchain override', 'cargo +nightly fuzz run roundtrip', true],
    ['cargo wrapper', 'cargo-zigbuild clippy --locked', true],
    ['feature powerset', 'cargo hack clippy --feature-powerset -- -D warnings', true],
    ['non-compiling command', 'cargo metadata --locked', false],
    ['uses step', undefined, false],
  ];
  for (const [name, run, expected] of cases) {
    test(name, () => {
      expect(
        compilesDebug({ run }),
        `expected debug compilation ${expected} | received script: ${run}`
      ).toBe(expected);
    });
  }
});

describe('CARGO_INCREMENTAL environment precedence', () => {
  const zero = { CARGO_INCREMENTAL: '0' };
  const one = { CARGO_INCREMENTAL: '1' };

  test('inherits from job and workflow, with step taking precedence', () => {
    expect(setsZero(undefined, undefined, zero)).toBe(true);
    expect(setsZero(undefined, zero, one)).toBe(true);
    expect(setsZero(zero, one, one)).toBe(true);
    expect(incrementalSetting(undefined, zero, one)).toBe('0');
  });

  test('rejects a narrower override despite outer zero', () => {
    expect(setsZero(one, zero, zero), 'expected step override 1 rejected | received accepted').toBe(
      false
    );
    expect(
      setsZero(undefined, one, zero),
      'expected job override 1 rejected | received accepted'
    ).toBe(false);
  });

  for (const value of [undefined, null, false, 'false', '1', '${{ vars.CARGO_INCREMENTAL }}']) {
    test(`rejects explicit invalid ${typeof value} value ${String(value)}`, () => {
      expect(
        setsZero({ CARGO_INCREMENTAL: value }, zero),
        `expected literal zero | received: ${String(value)}`
      ).toBe(false);
    });
  }

  test('accepts YAML number zero and rejects an absent setting', () => {
    expect(setsZero({ CARGO_INCREMENTAL: 0 })).toBe(true);
    expect(setsZero(undefined, {})).toBe(false);
  });
});

describe('YAML env mapping extraction', () => {
  test('reads block and inline mappings at the intended depth', () => {
    expect(environmentAt('env:\n  CARGO_INCREMENTAL: "0"\njobs:\n', 0)).toEqual({
      CARGO_INCREMENTAL: '0',
    });
    expect(environmentAt('    env: { CARGO_INCREMENTAL: 0 }\n    steps:\n', 4)).toEqual({
      CARGO_INCREMENTAL: 0,
    });
    expect(
      environmentAt('      run: |\n        env:\n          CARGO_INCREMENTAL: "0"\n', 6)
    ).toBeUndefined();
  });

  test('reads a first-key step env for workflow and composite list indents', () => {
    expect(
      stepInfo('      - env:\n          CARGO_INCREMENTAL: "0"\n        run: cargo check\n').env
    ).toEqual({ CARGO_INCREMENTAL: '0' });
    expect(
      stepInfo('    - env:\n        CARGO_INCREMENTAL: 0\n      run: cargo check\n').env
    ).toEqual({ CARGO_INCREMENTAL: 0 });
  });
});

describe('CARGO_INCREMENTAL in CI', () => {
  test('a job override cannot be satisfied by the workflow environment', () => {
    const workflow =
      'env:\n  CARGO_INCREMENTAL: "0"\njobs:\n  compile:\n    env:\n      CARGO_INCREMENTAL: "1"\n    steps:\n      - run: cargo check --locked\n';
    const [job] = cargoJobs('override.yml', workflow);
    expect(
      setsZero(job.compilingSteps[0].env, job.env, job.workflowEnv),
      'expected effective CARGO_INCREMENTAL=1 rejected | received accepted'
    ).toBe(false);
  });

  test('script text cannot impersonate a step environment setting', () => {
    const workflow =
      'jobs:\n  compile:\n    steps:\n      - run: |\n          CARGO_INCREMENTAL: "0"\n          cargo check --locked\n';
    const [job] = cargoJobs('script.yml', workflow);
    expect(
      setsZero(job.compilingSteps[0].env, job.env, job.workflowEnv),
      'expected actual env mapping | received accepted script text'
    ).toBe(false);
  });

  test('release-only and non-compiling jobs are excluded', () => {
    expect(
      cargoJobs(
        'release.yml',
        'jobs:\n  release:\n    steps:\n      - run: cargo build --release\n  format:\n    steps:\n      - run: cargo fmt --all\n'
      )
    ).toEqual([]);
    expect(cargoJobs('empty.yml', 'name: empty\n')).toEqual([]);
  });

  test('the derivation finds the jobs it is meant to guard', () => {
    const names = workflowFiles()
      .flatMap((file) => cargoJobs(file, readText(file)))
      .map(({ file, name }) => `${file.split('/').pop()}:${name}`);
    for (const expected of [
      'cargo-shim.yml:workspace',
      'cargo-shim.yml:workspace-msrv',
      'cargo-shim.yml:workspace-windows-arm64',
      'protocol-ci.yml:rust',
      'rust-coverage.yml:coverage',
      'rust-fresh-dependencies.yml:fresh',
    ])
      expect(names, `expected compiling job ${expected} | received: ${names}`).toContain(expected);
  });

  test('every debug compilation receives CARGO_INCREMENTAL=0', () => {
    const missing = workflowFiles()
      .flatMap((file) => cargoJobs(file, readText(file)))
      .flatMap((job) =>
        job.compilingSteps
          .filter((step) => !setsZero(step.env, job.env, job.workflowEnv))
          .map(
            (step) =>
              `${job.file} job '${job.name}' step '${step.name ?? step.run}': ${String(incrementalSetting(step.env, job.env, job.workflowEnv))}`
          )
      );
    expect(
      missing,
      `expected effective CARGO_INCREMENTAL: "0" for every debug compilation | received: ${missing.join('; ')}`
    ).toEqual([]);
  });

  test('every compiling composite step declares CARGO_INCREMENTAL=0', () => {
    const steps = compositeActionFiles().flatMap((file) => {
      return extractStepBlocksAtIndent(readText(file), 4)
        .map(stepInfo)
        .filter(compilesDebug)
        .map((step) => ({ file, step }));
    });
    expect(
      steps.length,
      'expected at least one compiling composite step | received none'
    ).toBeGreaterThan(0);
    const missing = steps
      .filter(({ step }) => !setsZero(step.env))
      .map(
        ({ file, step }) =>
          `${file} step '${step.name ?? step.run}': ${String(incrementalSetting(step.env))}`
      );
    expect(
      missing,
      `expected CARGO_INCREMENTAL: "0" in every compiling composite step env | received: ${missing.join('; ')}`
    ).toEqual([]);
  });
});
