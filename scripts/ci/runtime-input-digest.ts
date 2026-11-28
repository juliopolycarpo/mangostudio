#!/usr/bin/env bun
// Computes the input digest of one release platform's unstamped runtime
// (scripts/lib/runtime-input-digest.ts) and, after the build, stages the
// unstamped cargo output with a receipt for upload. Stage 2 of issue #2698:
// nothing reads the result yet, and the workflow step that calls `stage`
// cannot fail the build.
//
// Dependency-free: the runtime build job runs it with `bun --no-install`.
// Usage:
//   bun --no-install ./scripts/ci/runtime-input-digest.ts digest --platform linux-x64 --profile shipping --zig
//   bun --no-install ./scripts/ci/runtime-input-digest.ts stage --platform linux-x64 --profile shipping --zig \
//     --digest <hex> --out <dir>
// `digest` prints the digest (`--manifest` prints the canonical manifest) and
// writes `digest=` to $GITHUB_OUTPUT when set. It refuses a checkout whose
// runtime inputs are modified or untracked; `--allow-dirty` (local only) hashes
// the working files instead and says so. `stage` recomputes the digest after
// the build and requires it to equal `--digest`.

import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertNoUnexpectedArguments, fatal, parseArgs } from '../lib/args';
import { ROOT_DIR } from '../lib/config';
import { log } from '../lib/log';
import { runtimeBinaryName } from '../lib/release-targets';
import {
  cargoRuntimeBuildCommand,
  cargoRuntimeOutputPath,
  cargoTargetDir,
  rustTargetTriple,
  selectRuntimeTargets,
} from '../lib/runtime-build';
import {
  applyWorktreeChanges,
  assertCleanRuntimeInputs,
  buildRuntimeInputReceipt,
  canonicalRuntimeManifest,
  dirtyRuntimeInputs,
  type HashObject,
  observeBuildEnv,
  observeBuildTools,
  parseIndexListing,
  parseWorktreeStatus,
  readRuntimeProducer,
  renderDeterminismSummary,
  type RuntimeBuildFacts,
  runtimeInputDigest,
  type RuntimeInputFile,
  type RuntimeInputReceipt,
  selectRuntimeInputs,
  type ToolOutput,
  type ToolRunner,
  unstampedArtifactName,
} from '../lib/runtime-input-digest';
import { readReleaseStamp } from '../lib/runtime-stamp';

/** What the digest needs from git, so tests need no repository. */
export interface GitPort {
  /** `git ls-files -s -z` */
  readonly indexListing: () => string;
  /** `git status --porcelain -z --untracked-files=all --no-renames` */
  readonly worktreeStatus: () => string;
  /** `git hash-object -- <path>` */
  readonly hashObject: HashObject;
}

const RUNTIME_PROFILES = ['shipping', 'light'] as const;

/** Stand-in for the builder's Cargo home in the hashed command; see the library header. */
const CARGO_HOME_PLACEHOLDER = '<CARGO_HOME>';

export interface RuntimeInputOptions {
  readonly platform: string;
  readonly profile: string;
  readonly zig: boolean;
  readonly allowDirty: boolean;
}

export interface CollectedRuntimeInputs {
  readonly files: readonly RuntimeInputFile[];
  readonly facts: RuntimeBuildFacts;
  readonly digest: string;
  /** Inputs read from the working tree instead of the index (`--allow-dirty` only). */
  readonly dirty: readonly string[];
}

/**
 * Every input of one platform's unstamped runtime, observed from git and the
 * tool chain. Throws, naming the invalid value, on an unknown platform or
 * profile, a missing or modified tracked input, or a tool that will not run.
 *
 * @example
 * collectRuntimeInputs(realGit(), { platform: 'linux-x64', profile: 'shipping', zig: true, allowDirty: false }, run, process.env);
 */
export function collectRuntimeInputs(
  git: GitPort,
  options: RuntimeInputOptions,
  run: ToolRunner,
  env: Readonly<Record<string, string | undefined>>
): CollectedRuntimeInputs {
  const targets = selectRuntimeTargets(options.platform, undefined);
  if (targets.length !== 1 || options.platform.trim() !== targets[0]?.arch) {
    throw new Error(
      `expected --platform: exactly one release platform id | received: ${JSON.stringify(options.platform)}`
    );
  }
  const target = targets[0];
  if (!(RUNTIME_PROFILES as readonly string[]).includes(options.profile)) {
    throw new Error(
      `expected --profile ${RUNTIME_PROFILES.join(' | ')} | received: ${JSON.stringify(options.profile)}`
    );
  }

  const changes = parseWorktreeStatus(git.worktreeStatus());
  const dirty = dirtyRuntimeInputs(changes);
  if (!options.allowDirty) assertCleanRuntimeInputs(changes);
  const index = parseIndexListing(git.indexListing());
  const tree = dirty.length > 0 ? applyWorktreeChanges(index, dirty, git.hashObject) : index;
  const files = selectRuntimeInputs(tree);

  const command = cargoRuntimeBuildCommand(target.arch, {
    zig: options.zig,
    cargoHome: CARGO_HOME_PLACEHOLDER,
  });
  const facts: RuntimeBuildFacts = {
    platform: target.arch,
    triple: rustTargetTriple(target.arch),
    profile: options.profile,
    cargoProfile: 'release',
    command,
    env: observeBuildEnv(env),
    tools: observeBuildTools(command, run),
  };
  return {
    files,
    facts,
    digest: runtimeInputDigest(files, facts),
    dirty: dirty.map((change) => change.path),
  };
}

/** The binary that goes into the artifact, and its identity. */
export interface StagedUnstampedRuntime {
  readonly receipt: RuntimeInputReceipt;
  readonly artifactName: string;
  readonly binaryPath: string;
  readonly receiptPath: string;
}

/**
 * Copy cargo's own output (never the stamped staged copy) into `outDir` beside
 * a receipt. Refuses a binary that carries a release stamp or no stamp slot:
 * what is published must be the bytes every version derives from.
 *
 * @example
 * stageUnstampedRuntime({ cargoOutput, outDir, inputs, producer, binaryName: 'mangostudio-runtime' });
 */
export function stageUnstampedRuntime(options: {
  readonly cargoOutput: string;
  readonly outDir: string;
  readonly binaryName: string;
  readonly inputs: CollectedRuntimeInputs;
  readonly producer: RuntimeInputReceipt['producer'];
}): StagedUnstampedRuntime {
  const bytes = readFileSync(options.cargoOutput);
  const stamp = readReleaseStamp(bytes);
  if (stamp.version !== null) {
    throw new Error(
      `expected an unstamped runtime at ${options.cargoOutput} | received release stamp: ${stamp.version}`
    );
  }
  const { inputs } = options;
  const receipt = buildRuntimeInputReceipt({
    digest: inputs.digest,
    files: inputs.files,
    facts: inputs.facts,
    binary: {
      name: options.binaryName,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    },
    producer: options.producer,
    dirty: inputs.dirty,
  });
  mkdirSync(options.outDir, { recursive: true });
  const binaryPath = join(options.outDir, options.binaryName);
  const receiptPath = join(options.outDir, 'receipt.json');
  copyFileSync(options.cargoOutput, binaryPath);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return {
    receipt,
    artifactName: unstampedArtifactName(inputs.facts.platform, inputs.digest),
    binaryPath,
    receiptPath,
  };
}

function runTool(cwd: string): (command: readonly string[]) => ToolOutput {
  return (command) => {
    const result = Bun.spawnSync({ cmd: [...command], cwd, stdout: 'pipe', stderr: 'pipe' });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
}

function realGit(): GitPort {
  const git = (args: string[]): string => {
    const result = runTool(ROOT_DIR)(['git', ...args]);
    if (result.exitCode !== 0) {
      throw new Error(
        `expected git ${args[0]} to exit 0 | received: ${result.exitCode} ${result.stderr.trim()}`
      );
    }
    return result.stdout;
  };
  return {
    indexListing: () => git(['ls-files', '-s', '-z']),
    worktreeStatus: () =>
      git(['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames']),
    hashObject: (path) => git(['hash-object', '--', path]).trim(),
  };
}

function appendIfSet(variable: string, text: string): void {
  const target = process.env[variable];
  if (target) appendFileSync(target, text);
}

if (import.meta.main) {
  const { flags, values, positional } = parseArgs({
    booleanFlags: ['--zig', '--allow-dirty', '--manifest'],
    valueFlags: ['--platform', '--profile', '--digest', '--out'],
  });
  const [command, ...rest] = positional;
  assertNoUnexpectedArguments(rest);
  try {
    if (command !== 'digest' && command !== 'stage') {
      throw new Error(`expected command digest | stage | received: ${command ?? '(none)'}`);
    }
    const inputs = collectRuntimeInputs(
      realGit(),
      {
        platform: values['--platform'] ?? '',
        profile: values['--profile'] ?? '',
        zig: flags['--zig'] ?? false,
        allowDirty: flags['--allow-dirty'] ?? false,
      },
      runTool(ROOT_DIR),
      process.env
    );
    if (inputs.dirty.length > 0) {
      log(`dirty runtime inputs hashed from the working tree: ${inputs.dirty.join(', ')}`);
    }

    if (command === 'digest') {
      process.stdout.write(
        flags['--manifest']
          ? canonicalRuntimeManifest(inputs.files, inputs.facts)
          : `${inputs.digest}\n`
      );
      appendIfSet('GITHUB_OUTPUT', `digest=${inputs.digest}\n`);
    } else {
      // Staging is CI-only: a dirty tree never produces a reusable base.
      if (inputs.dirty.length > 0) {
        throw new Error(
          `expected clean runtime inputs to stage | received: ${inputs.dirty.join(', ')}`
        );
      }
      const expected = values['--digest'];
      if (inputs.digest !== expected) {
        throw new Error(
          `expected the digest computed before the build (${expected ?? '(unset)'}) | received: ${inputs.digest}; a runtime input or tool changed during the build`
        );
      }
      const out = values['--out'];
      if (!out) throw new Error('expected --out <dir> | received: (unset)');
      const target = selectRuntimeTargets(inputs.facts.platform, undefined)[0];
      if (!target)
        throw new Error(`expected a release target | received: ${inputs.facts.platform}`);
      const staged = stageUnstampedRuntime({
        cargoOutput: cargoRuntimeOutputPath(cargoTargetDir(ROOT_DIR), target),
        outDir: out,
        binaryName: runtimeBinaryName(target.name),
        inputs,
        producer: readRuntimeProducer(
          process.env,
          process.platform,
          runTool(ROOT_DIR),
          inputs.facts.command[1] === 'zigbuild'
        ),
      });
      log(
        `unstamped ${staged.receipt.target.platform}: ${staged.receipt.binary.sha256} (digest ${inputs.digest})`
      );
      appendIfSet('GITHUB_STEP_SUMMARY', renderDeterminismSummary(staged.receipt));
      appendIfSet('GITHUB_OUTPUT', `name=${staged.artifactName}\n`);
    }
  } catch (caught) {
    fatal(caught instanceof Error ? caught.message : String(caught));
  }
}
