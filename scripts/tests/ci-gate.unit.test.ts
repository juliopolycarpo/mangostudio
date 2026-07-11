import { describe, expect, test } from 'bun:test';

import { evaluateGate, parseAllowedSkips, parseNeeds } from '../ci/evaluate-gate';
import { readText } from './support/read-text';
import {
  extractJobBlock,
  extractJobBlocks,
  extractOnBlock,
  parseNeedsList,
  sectionKeys,
} from './support/workflow-blocks';

// CI gating policy: one authoritative run per PR commit, and one stable
// always-reporting Gate check per workflow that branch protection can require
// without tracking internal job names, matrix shapes, or path filters.

const GATED_WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/cargo-shim.yml',
  '.github/workflows/release-dry-run.yml',
] as const;

describe('gate result evaluation', () => {
  const skips = parseAllowedSkips('qa-metrics');

  test('passes when every dependency succeeded', () => {
    const verdict = evaluateGate({ check: 'success', test: 'success' }, new Set());
    expect(verdict.ok).toBe(true);
  });

  test.each([
    'failure',
    'cancelled',
    'skipped',
  ] as const)('fails when a mandatory dependency result is %s', (result) => {
    const verdict = evaluateGate({ check: 'success', test: result }, new Set());
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.join('\n')).toContain(`test: ${result}`);
  });

  test('accepts a skip only for a declared conditional lane', () => {
    expect(evaluateGate({ check: 'success', 'qa-metrics': 'skipped' }, skips).ok).toBe(true);
    expect(evaluateGate({ check: 'success', 'qa-metrics': 'skipped' }, new Set()).ok).toBe(false);
  });

  test('a declared conditional lane that ran and failed still fails the gate', () => {
    expect(evaluateGate({ check: 'success', 'qa-metrics': 'failure' }, skips).ok).toBe(false);
  });

  test('one failure is not masked by other successes or accepted skips', () => {
    const verdict = evaluateGate(
      { check: 'success', test: 'failure', 'qa-metrics': 'skipped' },
      skips
    );
    expect(verdict.ok).toBe(false);
  });

  test('an empty needs context fails instead of passing vacuously', () => {
    expect(evaluateGate({}, new Set()).ok).toBe(false);
  });

  test('an allowed-skip job that is not a dependency is configuration drift', () => {
    const verdict = evaluateGate({ check: 'success' }, parseAllowedSkips('renamed-job'));
    expect(verdict.ok).toBe(false);
    expect(verdict.lines.join('\n')).toContain('renamed-job');
  });

  test('parseAllowedSkips splits on whitespace and commas and drops empties', () => {
    expect(parseAllowedSkips(' a  b,c ')).toEqual(new Set(['a', 'b', 'c']));
    expect(parseAllowedSkips('')).toEqual(new Set());
    expect(parseAllowedSkips(undefined)).toEqual(new Set());
  });

  test('parseNeeds reads the toJSON(needs) shape and rejects malformed input', () => {
    expect(parseNeeds('{"check":{"result":"success","outputs":{}}}')).toEqual({
      check: 'success',
    });
    expect(() => parseNeeds(undefined)).toThrow('NEEDS is required');
    expect(() => parseNeeds('not json')).toThrow('not valid JSON');
    expect(() => parseNeeds('[]')).toThrow('JSON object form');
    expect(() => parseNeeds('{"check":{}}')).toThrow('unrecognized result');
    expect(() => parseNeeds('{"check":{"result":"green"}}')).toThrow('unrecognized result');
  });
});

describe('ci.yml trigger and concurrency policy', () => {
  const workflow = readText('.github/workflows/ci.yml');

  test('runs only for PRs to main, pushes to main, and manual dispatch', () => {
    const onBlock = extractOnBlock(workflow);

    expect(sectionKeys(onBlock)).toEqual(['pull_request', 'push', 'workflow_dispatch']);
    expect(onBlock).toContain('pull_request:\n    branches: [main]');
    expect(onBlock).toContain('push:\n    branches: [main]');
    // No branch-prefix allowlist: development branches get CI via their PR.
    expect(onBlock).not.toContain('/**');
  });

  test('one authoritative run per PR: keyed by PR number, never by SHA', () => {
    expect(workflow).toContain(
      "group: ${{ github.workflow }}-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.ref }}"
    );
    // A new push must supersede the previous run — except on main, where every
    // push has to reach Canary.
    expect(workflow).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}");
    expect(workflow).not.toContain('github.sha');
  });
});

describe('CI / Gate aggregate', () => {
  const workflow = readText('.github/workflows/ci.yml');
  const gateBlock = extractJobBlock(workflow, 'gate');

  test('needs every job except itself and canary, so new jobs cannot bypass it', () => {
    const jobs = extractJobBlocks(workflow).map(({ job }) => job);
    const mandatory = jobs.filter((job) => job !== 'gate' && job !== 'canary');

    expect(jobs).toContain('gate');
    expect(parseNeedsList(gateBlock).sort()).toEqual([...mandatory].sort());
  });

  test('qa-metrics is the only lane allowed to skip, and only on workflow_dispatch', () => {
    expect(gateBlock).toContain(
      "ALLOWED_SKIPS: ${{ github.event_name == 'workflow_dispatch' && 'qa-metrics' || '' }}"
    );
  });
});

describe('cargo-shim.yml always-reporting gate', () => {
  const workflow = readText('.github/workflows/cargo-shim.yml');

  test('triggers on every PR; only the push trigger keeps a path filter', () => {
    const onBlock = extractOnBlock(workflow);

    expect(sectionKeys(onBlock)).toEqual(['pull_request', 'push', 'workflow_dispatch']);
    // pull_request must not be path-filtered, or the Gate check would hang as
    // "expected" on non-Rust PRs.
    expect(onBlock).toContain('pull_request:\n    branches: [main]\n  push:');
    expect(onBlock).toContain('- "packages/cargo-shim/**"');
  });

  test('the Rust lane runs only when the changes job saw a Rust path', () => {
    const shimBlock = extractJobBlock(workflow, 'cargo-shim');

    expect(parseNeedsList(shimBlock)).toEqual(['changes']);
    expect(shimBlock).toContain("if: needs.changes.outputs.cargo_shim == 'true'");
    expect(workflow).toContain(
      String.raw`grep -Eq '^(packages/cargo-shim/|\.github/workflows/cargo-shim\.yml$)'`
    );
  });

  test('gate accepts the Rust lane skip only when no Rust path changed', () => {
    const gateBlock = extractJobBlock(workflow, 'gate');

    expect(parseNeedsList(gateBlock).sort()).toEqual(['cargo-shim', 'changes']);
    expect(gateBlock).toContain(
      "ALLOWED_SKIPS: ${{ needs.changes.outputs.cargo_shim == 'false' && 'cargo-shim' || '' }}"
    );
  });
});

describe('release-dry-run.yml always-reporting gate', () => {
  const workflow = readText('.github/workflows/release-dry-run.yml');

  test('triggers on every PR without a path filter, plus schedule and dispatch', () => {
    const onBlock = extractOnBlock(workflow);

    expect(sectionKeys(onBlock)).toEqual(['pull_request', 'workflow_dispatch', 'schedule']);
    expect(onBlock).toContain('pull_request:\n    branches: [main]\n  workflow_dispatch:');
  });

  test('each dry-run lane runs only when its relevance predicate is true', () => {
    const linuxBlock = extractJobBlock(workflow, 'dry-run-linux');
    const cargoBlock = extractJobBlock(workflow, 'dry-run-cargo');

    expect(parseNeedsList(linuxBlock)).toEqual(['changes']);
    expect(linuxBlock).toContain("if: needs.changes.outputs.release == 'true'");
    expect(parseNeedsList(cargoBlock)).toEqual(['changes']);
    expect(cargoBlock).toContain("if: needs.changes.outputs.cargo_shim == 'true'");
  });

  test('non-PR events treat every lane as relevant (weekly drift check)', () => {
    expect(workflow).toContain('if [ "$EVENT_NAME" != "pull_request" ]; then');
    expect(workflow).toContain('echo "release=true" >> "$GITHUB_OUTPUT"');
  });

  test('gate accepts each lane skip only when its predicate evaluated false', () => {
    const gateBlock = extractJobBlock(workflow, 'gate');

    expect(parseNeedsList(gateBlock).sort()).toEqual(['changes', 'dry-run-cargo', 'dry-run-linux']);
    expect(gateBlock).toContain(
      "ALLOWED_SKIPS: ${{ format('{0} {1}', needs.changes.outputs.release == 'false' && 'dry-run-linux' || '', needs.changes.outputs.cargo_shim == 'false' && 'dry-run-cargo' || '') }}"
    );
  });
});

describe('shared gate job contract', () => {
  test.each([...GATED_WORKFLOWS])('%s gate always runs the tested evaluator', (path) => {
    const workflow = readText(path);
    const gateBlock = extractJobBlock(workflow, 'gate');
    expect(gateBlock, `gate job not found in ${path}`).not.toBe('');

    // Runs regardless of dependency outcomes, else a failure would skip the
    // check instead of failing it; evaluation happens in the unit-tested
    // script, not a YAML expression.
    expect(gateBlock).toContain('if: ${{ always() }}');
    expect(gateBlock).toContain('name: Gate');
    expect(gateBlock).toContain('permissions:\n      contents: read');
    expect(gateBlock).toContain('NEEDS: ${{ toJSON(needs) }}');
    expect(gateBlock).toContain('run: bun ./scripts/ci/evaluate-gate.ts');
  });
});
