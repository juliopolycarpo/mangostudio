import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { evaluateGate, parseAllowedSkips } from '../ci/evaluate-gate';
import { ROOT_DIR } from '../lib/config';
import { RUST_CHECK_TASKS } from '../lib/rust-workspace-lane';
import { readText } from './support/read-text';
import { extractJobBlock, extractStepBlocks, parseNeedsList } from './support/workflow-blocks';

// Cargo Shim fails on a dependency no source reads. Cargo's own
// `unused_dependencies` lint skips dev-dependencies, so `cargo shear` carries
// the check. These tests pin the step, its install and its allowlist so none of
// them can drop out without a test failing.

const SHEAR_COMMAND = 'cargo shear --deny-warnings --locked';

const workflow = readText('.github/workflows/cargo-shim.yml');
const workspaceSteps = extractStepBlocks(extractJobBlock(workflow, 'workspace'));

const installStep = workspaceSteps.find((step) => step.includes('tool: cargo-shear@'));
const checkStep = workspaceSteps.find((step) => step.includes(`run: ${SHEAR_COMMAND}\n`));

describe('Cargo Shim unused-dependency check', () => {
  test('the workspace job runs cargo shear over the whole workspace', () => {
    expect(checkStep, `expected a workspace step running: ${SHEAR_COMMAND}`).toBeDefined();
    // No `-p` or `--exclude`: a member left out of the scan is a member that can drift.
    expect(checkStep).not.toMatch(/\s(?:-p|--package|--exclude)[\s=]/);
  });

  test('installs cargo-shear at an exact version through the SHA-pinned install action', () => {
    expect(installStep, 'expected a step installing cargo-shear@<version>').toBeDefined();
    expect(installStep).toMatch(/uses: taiki-e\/install-action@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/);
    expect(installStep).toMatch(/tool: cargo-shear@\d+\.\d+\.\d+\n/);
    expect(installStep).toContain('id: setup-shear');
    expect(installStep).not.toContain('continue-on-error:');
  });

  test('the check runs after the install and only when the install succeeded', () => {
    const installIndex = workspaceSteps.findIndex((step) => step.includes('tool: cargo-shear@'));
    const checkIndex = workspaceSteps.findIndex((step) => step.includes(`run: ${SHEAR_COMMAND}\n`));
    expect(checkIndex, 'cargo shear must run after its install step').toBeGreaterThan(installIndex);
    expect(checkStep).toContain("steps.setup-shear.outcome == 'success'");
    expect(checkStep).not.toContain('continue-on-error:');
  });

  test('both steps run on Ubuntu only, one run per workflow', () => {
    for (const step of [installStep, checkStep]) {
      expect(step).toContain("matrix.os == 'ubuntu-latest'");
    }
  });

  test('Cargo Shim Gate needs the workspace job and fails when it fails', () => {
    const gate = extractJobBlock(workflow, 'gate-unique');
    expect(parseNeedsList(gate)).toContain('workspace');
    // The only skip the gate grants the job is the "no Rust change" one.
    expect(gate).toContain(
      "needs.changes.outputs.rust == 'false' && 'workspace workspace-windows-arm64 musl-clippy'"
    );
    expect(evaluateGate({ workspace: 'failure' }, parseAllowedSkips('')).ok).toBe(false);
  });

  test('the local Rust check lane runs the same command', () => {
    const task = RUST_CHECK_TASKS.find((candidate) => candidate.label === 'rust:unused-deps');
    expect(task?.cmd.join(' ')).toBe(SHEAR_COMMAND);
  });
});

describe('cargo-shear allowlist', () => {
  // Every workspace member lives directly under crates/; the fuzz workspace
  // is a child of one of them and is not scanned.
  const manifests = [
    'Cargo.toml',
    ...readdirSync(join(ROOT_DIR, 'crates')).map((crate) => `crates/${crate}/Cargo.toml`),
  ];

  test('finds the member manifests', () => {
    expect(manifests.length).toBeGreaterThan(1);
  });

  test.each(manifests)('%s keeps a reason comment above every cargo-shear table', (path) => {
    const lines = readText(path).split('\n');
    lines.forEach((line, index) => {
      if (!/^\[(?:package|workspace)\.metadata\.cargo-shear\]/.test(line)) return;
      expect(
        lines[index - 1]?.startsWith('#'),
        `${path}:${index + 1}: expected a "# reason" comment line directly above ${line} | received: ${JSON.stringify(lines[index - 1])}`
      ).toBe(true);
    });
  });
});
